// Parser tests: llama.cpp fidelity (newline rules, escapes, repetition
// binding) and the quality of syntax errors — every P-code fires with a
// position and, where it matters, a fix-it hint.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseGbnf } from "../dist/parse.js";
import { grammar } from "./helpers.mjs";

function parseError(src) {
  const { grammar: g, error } = parseGbnf(src);
  assert.equal(g, null, "expected a parse error");
  return error;
}

test("a minimal grammar parses; comments are skipped everywhere", () => {
  const g = grammar('# heading\nroot ::= "hi" other # trailing\nother ::= [a-z]\n# footer\n');
  assert.deepEqual(g.order, ["root", "other"]);
  assert.equal(g.defs.length, 2);
  assert.equal(g.rules.get("root").alts.length, 1);
});

test("rule names take digits and dashes; underscore is P009, missing ::= is P002", () => {
  const g = grammar('root ::= step-2\nstep-2 ::= "x"\n');
  assert.ok(g.rules.has("step-2"));
  const p009 = parseError('my_rule ::= "x"\n');
  assert.equal(p009.code, "P009");
  assert.match(p009.message, /letters, digits and "-"/);
  const p002 = parseError('root = "x"\n');
  assert.equal(p002.code, "P002");
  assert.match(p002.message, /"root"/);
});

test("the body may start on the line after ::= (llama.cpp json.gbnf style)", () => {
  const g = grammar('root ::=\n  "value"\n');
  assert.equal(g.rules.get("root").alts[0][0].value, "value");
});

test("newlines are allowed inside groups but end a top-level sequence", () => {
  const g = grammar('root ::= "{" (\n  item ("," item)*\n)? "}"\nitem ::= [a-z]\n');
  assert.deepEqual(g.order, ["root", "item"]);
  // Top level: the newline after "a" ends root; "next" is a new rule.
  const g2 = grammar('root ::= "a"\nnext ::= "b"\n');
  assert.equal(g2.rules.get("root").alts[0].length, 1);
});

test('trailing "|" continues to the next line; a leading "|" is P008', () => {
  const g = grammar('root ::= "a" |\n  "b"\n');
  assert.equal(g.rules.get("root").alts.length, 2);
  const err = parseError('root ::= "a"\n  | "b"\n');
  assert.equal(err.code, "P008");
  assert.equal(err.line, 2);
  assert.match(err.message, /end of the previous line|wrap the whole rule body/);
});

test("named escapes and hex escapes decode to the right code points", () => {
  const g = grammar('root ::= "\\n\\t\\r\\\\\\"\\[\\]" "\\x41\\u00e9\\U0001F600"\n');
  const [first, second] = g.rules.get("root").alts[0];
  assert.equal(first.value, '\n\t\r\\"[]');
  assert.equal(second.value, "Aé\u{1F600}");
});

test("bad escapes are P005 with 1-based line and column", () => {
  assert.equal(parseError('root ::= "\\q"\n').code, "P005");
  assert.equal(parseError('root ::= "\\x4"\n').code, "P005");
  assert.equal(parseError('root ::= "\\U00110000"\n').code, "P005");
  const err = parseError('root ::= "ok"\nnext ::= "\\q"\n');
  assert.deepEqual([err.line, err.col], [2, 11]); // points at the backslash
  // "\-" has no escape in llama.cpp; the message says what to do instead.
  const dash = parseError("root ::= [a\\-z]\n");
  assert.equal(dash.code, "P005");
  assert.match(dash.message, /\\x2D/);
});

test("an unterminated literal is P003, at EOF and at a raw newline", () => {
  assert.equal(parseError('root ::= "abc').code, "P003");
  const err = parseError('root ::= "abc\n"def"\n');
  assert.equal(err.code, "P003");
  assert.match(err.message, /raw line break/);
});

test('char classes: ranges, negation, and a trailing "-" as a member', () => {
  const g = grammar('root ::= [^a-z0-9-]\n');
  const cls = g.rules.get("root").alts[0][0];
  assert.equal(cls.negated, true);
  assert.deepEqual(
    cls.items.map((i) => [i.lo, i.hi]),
    [[97, 122], [48, 57], [45, 45]]
  );
});

test("an unterminated class is P004; an empty class still parses", () => {
  assert.equal(parseError("root ::= [abc\n").code, "P004");
  const g = grammar("root ::= []\n"); // matching nothing is the linter's E005
  assert.equal(g.rules.get("root").alts[0][0].items.length, 0);
});

test("all repetition forms produce the right {min,max}", () => {
  const g = grammar('root ::= a* a+ a? a{3} a{2,} a{2,5} a{ 2 , 5 }\na ::= "a"\n');
  const bounds = g.rules.get("root").alts[0].map((n) => [n.min, n.max]);
  assert.deepEqual(bounds, [[0, null], [1, null], [0, 1], [3, 3], [2, null], [2, 5], [2, 5]]);
});

test("a repetition with nothing to repeat, or bad bounds, is P006", () => {
  assert.equal(parseError('root ::= * "a"\n').code, "P006");
  assert.equal(parseError('root ::= "a"{,3}\n').code, "P006");
  assert.equal(parseError('root ::= "a"{2\n').code, "P006");
  assert.equal(parseError('root ::= "a"{9999999999}\n').code, "P006");
});

test("repetition binds the whole previous element, as in llama.cpp", () => {
  const g = grammar('root ::= "ab"{2}\n');
  const rep = g.rules.get("root").alts[0][0];
  assert.equal(rep.kind, "rep");
  assert.equal(rep.item.value, "ab"); // repeats "ab", not just "b"
  // A space before the operator, and stacked operators, both parse.
  const g2 = grammar('root ::= "a" * ?\n');
  const outer = g2.rules.get("root").alts[0][0];
  assert.deepEqual([outer.min, outer.max], [0, 1]);
  assert.equal(outer.item.kind, "rep");
});

test("duplicate definitions keep every def but the last one wins", () => {
  const g = grammar('root ::= "a"\nroot ::= "b"\n');
  assert.equal(g.defs.length, 2);
  assert.equal(g.rules.get("root").alts[0][0].value, "b");
  assert.deepEqual(g.order, ["root"]);
});

test('a stray "::=" mid-body points at the missing-newline mistake', () => {
  const err = parseError('root ::= "a" next ::= "b"\n');
  assert.equal(err.code, "P007");
  assert.match(err.message, /trailing "\|" or a missing newline/);
});
