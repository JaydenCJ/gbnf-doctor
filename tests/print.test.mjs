// Printer tests: everything printGrammar emits must re-parse to the same
// canonical form (fixpoint), and every spelling must be one llama.cpp
// accepts — the tricky cases are "-" and "^" inside character classes.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { printGrammar, quoteLit } from "../dist/print.js";
import { parseGbnf } from "../dist/parse.js";
import { grammar } from "./helpers.mjs";

/** print(parse(x)) must be a fixpoint: reprinting the reparse is stable. */
function roundtrip(src) {
  const once = printGrammar(grammar(src));
  const twice = printGrammar(grammar(once));
  assert.equal(twice, once, `not a fixpoint:\n${once}`);
  return once;
}

test("simple rules, alternation and groups round-trip", () => {
  const out = roundtrip('root ::= "a" ( b | c )+\nb ::= [0-9]\nc ::= .\n');
  assert.equal(out, 'root ::= "a" ( b | c )+\nb ::= [0-9]\nc ::= .\n');
});

test("all repetition suffixes print canonically", () => {
  const out = roundtrip('root ::= a* a+ a? a{3} a{2,} a{2,5} a{1,1}\na ::= "a"\n');
  assert.match(out, /a\* a\+ a\? a\{3\} a\{2,\} a\{2,5\} a\{1\}/);
});

test("literals escape quotes, backslashes and control characters", () => {
  assert.equal(quoteLit('say "hi"\n'), '"say \\"hi\\"\\n"');
  assert.equal(quoteLit("\x01"), '"\\x01"');
  roundtrip('root ::= "tab\\there \\"q\\" \\\\ \\x07"\n');
});

test('literal "-" and leading "^" in classes print as llama.cpp-safe hex', () => {
  const out = roundtrip("root ::= [a-]\n");
  assert.equal(out, "root ::= [a\\x2D]\n");
  const items = grammar(out).rules.get("root").alts[0][0].items;
  assert.deepEqual(items.map((i) => i.lo), [97, 45]); // still 'a' and '-'
  const caret = printGrammar(grammar("root ::= [\\x5Eab]\n"));
  assert.equal(caret, "root ::= [\\x5Eab]\n");
  assert.equal(grammar(caret).rules.get("root").alts[0][0].negated, false);
});

test("printGrammar emits effective rules only, in first-definition order", () => {
  const g = grammar('root ::= "a"\nroot ::= "b"\n');
  assert.equal(printGrammar(g), 'root ::= "b"\n');
});

test("an empty alternative prints as the empty literal", () => {
  const out = roundtrip('root ::= "a" |\n');
  assert.equal(out, 'root ::= "a" | ""\n');
  // "" is only a warning (W106); the printed form still parses.
  assert.equal(parseGbnf(out).error, null);
});
