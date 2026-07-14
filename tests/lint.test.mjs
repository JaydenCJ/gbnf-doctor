// One test per lint rule (E001-E008, W101-W107), plus severity accounting
// and the parse-error passthrough. Each fixture is the smallest grammar
// that triggers the rule under test; unavoidable companion findings are
// asserted explicitly so nothing fires by accident.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lintGbnf, LINT_RULES } from "../dist/lint.js";

function codes(src) {
  return lintGbnf(src).diagnostics.map((d) => d.code);
}

function finding(src, code) {
  const hit = lintGbnf(src).diagnostics.find((d) => d.code === code);
  assert.ok(hit !== undefined, `expected ${code} to fire`);
  return hit;
}

test("a well-formed grammar produces zero findings", () => {
  const src = 'root ::= "[" item ("," item)* "]"\nitem ::= [a-z]{1,16}\n';
  assert.deepEqual(codes(src), []);
  const result = lintGbnf(src);
  assert.equal(result.ok, true);
  assert.deepEqual([result.errors, result.warnings], [0, 0]);
});

test('E001 fires when no rule is named "root"', () => {
  const d = finding('start ::= "x"\n', "E001");
  assert.equal(d.severity, "error");
  assert.match(d.message, /llama\.cpp requires/);
});

test("E002 fires per undefined reference, with a hint only when one is close", () => {
  const src = 'root ::= vlaue vlaue\nvalue ::= "1"\n';
  const hits = lintGbnf(src).diagnostics.filter((d) => d.code === "E002");
  assert.equal(hits.length, 2);
  assert.match(hits[0].message, /did you mean "value"\?/);
  const far = finding('root ::= zzzzzz\nvalue ::= "1"\n', "E002");
  assert.ok(!far.message.includes("did you mean"));
});

test("E003 fires on the second definition and cites the first line", () => {
  const d = finding('root ::= "a"\nroot ::= "b"\n', "E003");
  assert.equal(d.line, 2);
  assert.match(d.message, /first defined at line 1/);
  assert.match(d.message, /last definition/);
});

test("E004 catches direct, indirect and nullable-prefix left recursion", () => {
  const direct = finding('root ::= expr\nexpr ::= expr "+" term | term\nterm ::= [0-9]\n', "E004");
  assert.match(direct.message, /expr -> expr/);
  const indirect = 'root ::= a\na ::= b "x" | "y"\nb ::= a "z" | "w"\n';
  assert.ok(codes(indirect).includes("E004"));
  // "pad" can match empty, so "root" is still leftmost-reachable from itself.
  const nullablePrefix = 'root ::= pad root "x" | "x"\npad ::= " "?\n';
  assert.ok(codes(nullablePrefix).includes("E004"));
});

test("right recursion is legal and not confused with E004", () => {
  const src = 'root ::= item\nitem ::= [0-9] item | [0-9]\n';
  assert.deepEqual(codes(src), []);
});

test("E005 fires for [] but not for [^] (which matches any character)", () => {
  const found = codes('root ::= [] "x"\n');
  assert.ok(found.includes("E005"));
  // [] also makes root unproductive; that companion E008 is expected.
  assert.deepEqual(found.slice().sort(), ["E005", "E008"]);
  assert.ok(!codes('root ::= [^] "x"\n').includes("E005"));
});

test("E006 fires per reversed range and quotes the source spelling", () => {
  const d = finding("root ::= [z-a0-9]\n", "E006");
  assert.match(d.message, /"z-a"/);
});

test("E007 fires when a repetition has min greater than max", () => {
  const d = finding('root ::= "a"{3,2}\n', "E007");
  assert.match(d.message, /\{3,2\}/);
});

test("E008 fires for recursion with no base case, direct or mutual", () => {
  const d = finding('root ::= "x" root\n', "E008");
  assert.match(d.message, /never match/);
  assert.ok(codes('root ::= a\na ::= "x" b\nb ::= "y" a\n').includes("E008"));
  // ...but never as a cascade from an undefined reference (that is E002).
  assert.deepEqual(codes("root ::= missing\n"), ["E002"]);
});

test("W101 flags rules unreachable from root, but stays quiet without a root", () => {
  const d = finding('root ::= "a"\nhelper ::= "b"\n', "W101");
  assert.equal(d.severity, "warning");
  assert.equal(d.line, 2);
  // No root: E001 only — flagging everything unreachable would be noise.
  assert.deepEqual(codes('start ::= "x"\n'), ["E001"]);
});

test("W102 warns when the grammar accepts the empty string", () => {
  const d = finding("root ::= [a-z]*\n", "W102");
  assert.match(d.message, /empty string/);
  assert.ok(!codes("root ::= [a-z]+\n").includes("W102"));
});

test("W103 flags duplicate alternatives, canonicalized", () => {
  const d = finding('root ::= "a" | [x] | "a"\n', "W103");
  assert.match(d.message, /"a"/);
});

test("W104 flags overlapping or duplicate class members", () => {
  assert.ok(codes("root ::= [a-zA-Za-m]\n").includes("W104"));
  assert.ok(codes("root ::= [0-90]\n").includes("W104"));
  assert.ok(!codes("root ::= [a-zA-Z0-9]\n").includes("W104"));
});

test("W105 flags unbounded repetition over nullables; W106 flags empty literals", () => {
  const d = finding('root ::= ("x"?)* "end"\n', "W105");
  assert.match(d.message, /without consuming/);
  // Bounded repetition of a nullable element is redundant but terminates.
  assert.ok(!codes('root ::= ("x"?){3} "end"\n').includes("W105"));
  assert.ok(codes('root ::= "" "x"\n').includes("W106"));
});

test("W107 flags trailing unbounded repetition, through rules, unless guarded", () => {
  assert.ok(codes('root ::= line+\nline ::= [a-z]+ "\\n"\n').includes("W107"));
  const throughRef = 'root ::= "id: " tail\ntail ::= [a-z]*\n';
  assert.ok(!codes(throughRef).includes("W102"));
  assert.ok(codes(throughRef).includes("W107"));
  // Quiet when a terminator follows, or when the repetition is bounded.
  assert.deepEqual(codes('root ::= "[" [a-z]* "]"\n'), []);
  assert.deepEqual(codes('root ::= "x" [ \\t]{0,16}\n'), []);
});

test("findings are sorted by position; a parse error is the single finding", () => {
  const src = 'helper ::= "h"\nroot ::= [z-a] missing\n';
  const positions = lintGbnf(src).diagnostics.map((d) => [d.line, d.col]);
  const sorted = [...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  assert.deepEqual(positions, sorted);
  const broken = lintGbnf('root ::= "a\n');
  assert.equal(broken.diagnostics.length, 1);
  assert.equal(broken.diagnostics[0].code, "P003");
  assert.deepEqual([broken.ok, broken.errors], [false, 1]);
});

test("LINT_RULES documents all 15 rules with correct severities", () => {
  const keys = Object.keys(LINT_RULES);
  assert.equal(keys.length, 15);
  assert.equal(keys.filter((k) => k.startsWith("E")).length, 8);
  assert.equal(keys.filter((k) => k.startsWith("W")).length, 7);
  for (const [code, meta] of Object.entries(LINT_RULES)) {
    assert.equal(meta.severity, code.startsWith("E") ? "error" : "warning");
  }
});
