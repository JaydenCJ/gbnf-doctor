// Match-engine tests: acceptance/rejection semantics, the diagnostic
// payload (offset, line/col, got, expected), recursion, Unicode, and the
// guarantees around grammars llama.cpp refuses to load.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  compileGrammar,
  GrammarCompileError,
  MatchBudgetError,
} from "../dist/match.js";
import { grammar, match } from "./helpers.mjs";

test("a literal matches exactly; the first wrong character is located", () => {
  assert.equal(match('root ::= "true"\n', "true").outcome, "match");
  const r = match('root ::= "true"\n', "trxe");
  assert.equal(r.outcome, "nomatch");
  assert.deepEqual([r.offset, r.got], [2, "x"]);
  assert.deepEqual(r.expected, ['"u"']);
  // Extra input after a complete match points at the expected end.
  const extra = match('root ::= "ok"\n', "ok!");
  assert.deepEqual([extra.outcome, extra.offset], ["nomatch", 2]);
  assert.deepEqual(extra.expected, ["end of input"]);
});

test("character classes respect ranges and negation", () => {
  const src = "root ::= [a-f0-9] [^x]\n";
  assert.equal(match(src, "aq").outcome, "match");
  assert.equal(match(src, "gq").outcome, "nomatch");
  assert.equal(match(src, "ax").outcome, "nomatch");
});

test('"." matches any single character, including astral plane', () => {
  assert.equal(match('root ::= "<" . ">"\n', "<\u{1F600}>").outcome, "match");
  assert.equal(match('root ::= "<" . ">"\n', "<ab>").outcome, "nomatch");
});

test("alternation explores every branch", () => {
  const src = 'root ::= "yes" | "no" | "maybe"\n';
  for (const word of ["yes", "no", "maybe"]) {
    assert.equal(match(src, word).outcome, "match", word);
  }
  assert.equal(match(src, "nope").outcome, "nomatch");
});

test("repetition bounds are enforced at both ends; * and + behave", () => {
  const src = "root ::= [a-z]{2,4}\n";
  assert.equal(match(src, "a").outcome, "incomplete");
  assert.equal(match(src, "ab").outcome, "match");
  assert.equal(match(src, "abcd").outcome, "match");
  assert.equal(match(src, "abcde").outcome, "nomatch");
  assert.equal(match('root ::= "a"* "!"\n', "!").outcome, "match");
  assert.equal(match('root ::= "a"* "!"\n', "aaaa!").outcome, "match");
  assert.equal(match('root ::= "a"+ "!"\n', "!").outcome, "nomatch");
});

test("a repetition of a multi-character literal repeats the whole literal", () => {
  const src = 'root ::= "ab"{2}\n';
  assert.equal(match(src, "abab").outcome, "match");
  assert.equal(match(src, "abb").outcome, "nomatch");
});

test("right recursion works: a JSON-ish nested array grammar", () => {
  const src = 'root ::= arr\narr ::= "[" (item ("," item)*)? "]"\nitem ::= [0-9] | arr\n';
  assert.equal(match(src, "[1,[2,[]],3]").outcome, "match");
  assert.equal(match(src, "[1,[2,]").outcome, "nomatch");
});

test("unbounded repetition over a nullable item terminates; empty input works", () => {
  // Pathological but legal: each iteration may consume nothing. The
  // saturating repetition counter keeps the stack set finite.
  const src = 'root ::= ("x"?)* "end"\n';
  assert.equal(match(src, "xxend").outcome, "match");
  assert.equal(match(src, "end").outcome, "match");
  // The empty string matches iff the grammar is nullable.
  assert.equal(match("root ::= [a-z]*\n", "").outcome, "match");
  assert.equal(match("root ::= [a-z]+\n", "").outcome, "incomplete");
});

test("incomplete inputs report what the grammar expects next", () => {
  const r = match('root ::= "key=" [0-9]+\n', "key=");
  assert.equal(r.outcome, "incomplete");
  assert.deepEqual(r.expected, ['"0"-"9"']);
});

test("expected sets merge adjacent and overlapping ranges across stacks", () => {
  const r = match('root ::= [a-c] rest | [b-e] rest\nrest ::= "!"\n', "z");
  assert.equal(r.outcome, "nomatch");
  assert.deepEqual(r.expected, ['"a"-"e"']);
});

test("line and column track newlines in multi-line input", () => {
  const src = 'root ::= line line\nline ::= [a-z]+ "\\n"\n';
  const r = match(src, "abc\nde!\n");
  assert.equal(r.outcome, "nomatch");
  assert.deepEqual([r.line, r.col, r.got], [2, 3, "!"]);
});

test("negated classes describe themselves readably in expectations", () => {
  const r = match('root ::= "\\"" [^"\\\\]* "\\""\n', '"a\\');
  assert.equal(r.outcome, "nomatch");
  assert.ok(
    r.expected.some((e) => e.includes("any character except")),
    r.expected.join(", ")
  );
});

test("compileGrammar refuses what llama.cpp refuses, with matching codes", () => {
  const noRoot = grammar('start ::= "x"\n');
  assert.throws(
    () => compileGrammar(noRoot),
    (e) => e instanceof GrammarCompileError && e.code === "E001"
  );
  const undef = grammar("root ::= missing\n");
  assert.throws(() => compileGrammar(undef), (e) => e.code === "E002" && /missing/.test(e.message));
  const leftRec = grammar('root ::= root "x" | "x"\n');
  assert.throws(() => compileGrammar(leftRec), (e) => e.code === "E004" && /left recursion/.test(e.message));
});

test("a tiny work budget raises MatchBudgetError instead of hanging", () => {
  assert.throws(
    () => match("root ::= [a-z]{0,64} [a-z]{0,64} [a-z]{0,64}\n", "a".repeat(64), { budget: 50 }),
    (e) => e instanceof MatchBudgetError
  );
});

test("matching consumes code points, not UTF-16 units", () => {
  const src = "root ::= [\\U0001F600-\\U0001F64F]{2}\n";
  assert.equal(match(src, "\u{1F600}\u{1F60A}").outcome, "match");
  const r = match(src, "\u{1F600}");
  assert.equal(r.outcome, "incomplete");
  assert.equal(r.offset, 1); // one emoji = one code point, two UTF-16 units
});
