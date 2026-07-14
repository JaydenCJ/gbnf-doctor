// Flag-parser tests: both value syntaxes, the "--" terminator, and the
// hard-error policy for unknown or malformed flags.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseArgs, UsageError } from "../dist/cliargs.js";

const SPEC = { strict: "boolean", format: "string" };

test("positionals and flags separate cleanly", () => {
  const r = parseArgs(["file.gbnf", "--strict", "abc"], SPEC);
  assert.deepEqual(r.positionals, ["file.gbnf", "abc"]);
  assert.deepEqual(r.flags, { strict: true });
});

test('string flags accept both "--f v" and "--f=v"', () => {
  assert.equal(parseArgs(["--format", "json"], SPEC).flags.format, "json");
  assert.equal(parseArgs(["--format=json"], SPEC).flags.format, "json");
});

test('"--" ends flag parsing so grammar-test strings can start with dashes', () => {
  const r = parseArgs(["g.gbnf", "--", "--not-a-flag"], SPEC);
  assert.deepEqual(r.positionals, ["g.gbnf", "--not-a-flag"]);
});

test("unknown or malformed flags are hard errors, not silently ignored", () => {
  assert.throws(() => parseArgs(["--stric"], SPEC), UsageError);
  assert.throws(() => parseArgs(["--format"], SPEC), UsageError);
  assert.throws(() => parseArgs(["--strict=yes"], SPEC), UsageError);
});
