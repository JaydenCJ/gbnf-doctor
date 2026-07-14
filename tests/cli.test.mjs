// End-to-end CLI tests against the compiled dist/cli.js: subcommands,
// exit codes, output formats and error paths. Each test writes its own
// fixtures into a fresh temp dir; nothing touches the repo or the network.
import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, tempFiles } from "./helpers.mjs";

const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
);

const cleanups = [];
after(() => cleanups.forEach((fn) => fn()));

function files(map) {
  const t = tempFiles(map);
  cleanups.push(t.cleanup);
  return t.dir;
}

const GOOD = 'root ::= "n=" [0-9]{1,3}\n';
const BAD = 'root ::= vlaue\nvalue ::= "1"\nvalue ::= "2"\n';

test("--version matches package.json; --help documents the subcommands", () => {
  const version = run(["--version"]);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), PKG.version);
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  for (const word of ["lint", "test", "convert", "--prefix-ok"]) {
    assert.ok(help.stdout.includes(word), word);
  }
  assert.equal(run([]).code, 2);
  assert.equal(run(["frobnicate"]).code, 2);
});

test("subcommand --help prints usage; a bad --format value is a usage error", () => {
  const sub = run(["lint", "--help"]);
  assert.equal(sub.code, 0);
  assert.ok(sub.stdout.includes("Usage:"));
  const dir = files({ "good.gbnf": GOOD });
  const badFormat = run(["lint", join(dir, "good.gbnf"), "--format", "yaml"]);
  assert.equal(badFormat.code, 2);
  assert.match(badFormat.stderr, /--format must be "text" or "json", got "yaml"/);
  assert.equal(run(["test", join(dir, "good.gbnf"), "n=1", "--format=xml"]).code, 2);
});

test("lint: a clean grammar prints OK and exits 0", () => {
  const dir = files({ "good.gbnf": GOOD });
  const { code, stdout } = run(["lint", join(dir, "good.gbnf")]);
  assert.equal(code, 0);
  assert.match(stdout, /good\.gbnf: OK \(0 errors, 0 warnings\)/);
});

test("lint: findings print as file:line:col with codes (or JSON), exit 1", () => {
  const dir = files({ "bad.gbnf": BAD });
  const { code, stdout } = run(["lint", join(dir, "bad.gbnf")]);
  assert.equal(code, 1);
  assert.match(stdout, /bad\.gbnf:1:10: error E002 undefined rule "vlaue" \(did you mean "value"\?\)/);
  assert.match(stdout, /error E003/);
  assert.match(stdout, /FAIL \(2 errors, /);
  const asJson = run(["lint", join(dir, "bad.gbnf"), "--format", "json"]);
  assert.equal(asJson.code, 1);
  const parsed = JSON.parse(asJson.stdout);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.findings.some((f) => f.code === "E002" && f.line === 1));
});

test("lint --strict: warnings alone flip the exit code to 1", () => {
  const dir = files({ "warn.gbnf": 'root ::= "a"\nunused ::= "b"\n' });
  assert.equal(run(["lint", join(dir, "warn.gbnf")]).code, 0);
  const { code, stdout } = run(["lint", join(dir, "warn.gbnf"), "--strict"]);
  assert.equal(code, 1);
  assert.match(stdout, /warning W101/);
});

test("lint: an unreadable file is a usage error (exit 2)", () => {
  const { code, stderr } = run(["lint", "/nonexistent/nope.gbnf"]);
  assert.equal(code, 2);
  assert.match(stderr, /cannot read/);
});

test("test: MATCH / NO MATCH verdicts with positions, exit 1 on rejection", () => {
  const dir = files({ "g.gbnf": GOOD });
  const ok = run(["test", join(dir, "g.gbnf"), "n=42"]);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /MATCH "n=42"/);
  const bad = run(["test", join(dir, "g.gbnf"), "n=42", "n=x"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /NO MATCH "n=x" — at offset 2 \(line 1, col 3\): got "x", expected "0"-"9"/);
});

test("test: incomplete inputs fail by default but pass with --prefix-ok", () => {
  const dir = files({ "g.gbnf": GOOD });
  const strict = run(["test", join(dir, "g.gbnf"), "n="]);
  assert.equal(strict.code, 1);
  assert.match(strict.stdout, /INCOMPLETE "n=" — valid prefix/);
  assert.equal(run(["test", join(dir, "g.gbnf"), "n=", "--prefix-ok"]).code, 0);
});

test("test: --stdin and --file feed candidates; --chomp strips one newline", () => {
  const dir = files({ "g.gbnf": GOOD, "input.txt": "n=7\n" });
  const viaStdin = run(["test", join(dir, "g.gbnf"), "--stdin"], { input: "n=7" });
  assert.equal(viaStdin.code, 0);
  const viaFile = run(["test", join(dir, "g.gbnf"), "--file", join(dir, "input.txt")]);
  assert.equal(viaFile.code, 1); // trailing newline is part of the file
  const chomped = run(["test", join(dir, "g.gbnf"), "--file", join(dir, "input.txt"), "--chomp"]);
  assert.equal(chomped.code, 0);
});

test("test: a grammar that will not load exits 2 and points at lint", () => {
  const dir = files({ "bad.gbnf": BAD, "syntax.gbnf": 'root ::= "a\n' });
  const compileFail = run(["test", join(dir, "bad.gbnf"), "x"]);
  assert.equal(compileFail.code, 2);
  assert.match(compileFail.stderr, /E002/);
  const parseFail = run(["test", join(dir, "syntax.gbnf"), "x"]);
  assert.equal(parseFail.code, 2);
  assert.match(parseFail.stderr, /P003/);
  const noStrings = run(["test", join(dir, "bad.gbnf")]);
  assert.equal(noStrings.code, 2);
});

test("test --format json reports one entry per candidate", () => {
  const dir = files({ "g.gbnf": GOOD });
  const { code, stdout } = run(["test", join(dir, "g.gbnf"), "n=1", "nope", "--format", "json"]);
  assert.equal(code, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.results.length, 2);
  assert.deepEqual(
    parsed.results.map((r) => r.outcome),
    ["match", "nomatch"]
  );
  assert.equal(parsed.results[1].got, "o");
});

test("convert: stdout output lints clean; --out writes and counts rules", () => {
  const dir = files({
    "s.json": JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }),
    "enum.json": JSON.stringify({ enum: ["a", "b"] }),
  });
  const { code, stdout } = run(["convert", join(dir, "s.json")]);
  assert.equal(code, 0);
  assert.match(stdout, /root ::= /);
  const lintDir = files({ "generated.gbnf": stdout });
  assert.equal(run(["lint", join(lintDir, "generated.gbnf")]).code, 0);
  const out = join(dir, "enum.gbnf");
  const r = run(["convert", join(dir, "enum.json"), "--out", out]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /wrote .*enum\.gbnf \(\d+ rules\)/);
  assert.match(readFileSync(out, "utf8"), /"\\"a\\""/);
});

test("convert: notes go to stderr; --strict turns them into exit 1", () => {
  const dir = files({ "s.json": JSON.stringify({ type: "integer", minimum: 3 }) });
  const soft = run(["convert", join(dir, "s.json")]);
  assert.equal(soft.code, 0);
  assert.match(soft.stderr, /note: ignored "minimum"/);
  const strict = run(["convert", join(dir, "s.json"), "--strict"]);
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /strict mode/);
});

test("convert: invalid JSON and inexpressible schemas exit 2", () => {
  const dir = files({ "broken.json": "{ nope", "false.json": "false" });
  const badJson = run(["convert", join(dir, "broken.json")]);
  assert.equal(badJson.code, 2);
  assert.match(badJson.stderr, /not valid JSON/);
  const impossible = run(["convert", join(dir, "false.json")]);
  assert.equal(impossible.code, 2);
  assert.match(impossible.stderr, /matches nothing/);
});

test("the bundled examples behave as documented", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const ipv4 = join(root, "examples", "ipv4.gbnf");
  assert.equal(run(["lint", ipv4]).code, 0);
  assert.equal(run(["test", ipv4, "127.0.0.1", "192.168.0.1"]).code, 0);
  assert.equal(run(["test", ipv4, "256.1.1.1"]).code, 1);
  const broken = run(["lint", join(root, "examples", "broken.gbnf")]);
  assert.equal(broken.code, 1);
  for (const code of ["E002", "E004", "W101", "W103"]) {
    assert.ok(broken.stdout.includes(code), code);
  }
  const schema = run(["convert", join(root, "examples", "ticket.schema.json")]);
  assert.equal(schema.code, 0);
  assert.match(schema.stdout, /uuid/);
});
