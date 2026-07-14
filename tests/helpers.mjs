// Shared test helpers: parse-or-throw shortcuts and a spawnSync wrapper for
// CLI tests. Everything is deterministic and offline; temp files go into
// fresh mkdtemp directories cleaned up by the callers.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseGbnf } from "../dist/parse.js";
import { compileGrammar, matchText } from "../dist/match.js";

export const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Parse a grammar that the test requires to be valid. */
export function grammar(src) {
  const { grammar: g, error } = parseGbnf(src);
  assert.equal(error, null, `fixture must parse: ${error?.message}`);
  return g;
}

/** Parse + compile + match in one step for match tests. */
export function match(src, text, options) {
  return matchText(compileGrammar(grammar(src)), text, options);
}

/** Create a temp dir with the given files; returns { dir, cleanup }. */
export function tempFiles(files) {
  const dir = mkdtempSync(join(tmpdir(), "gbnf-doctor-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run the compiled CLI; returns { code, stdout, stderr }. */
export function run(args, options = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: options.input,
    cwd: options.cwd,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
