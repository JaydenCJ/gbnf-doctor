// Converter tests. The core contract is checked for every fixture: the
// generated grammar (a) lints clean with this package's own linter and
// (b) accepts/rejects the right JSON documents under this package's own
// match engine — so all three verbs are forced to agree with each other.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lintGbnf } from "../dist/lint.js";
import { compileGrammar, matchText } from "../dist/match.js";
import { parseGbnf } from "../dist/parse.js";
import { SchemaError, schemaToGbnf } from "../dist/schema.js";

/** Convert, assert the output lints clean, and return a matcher. */
function convert(schema, options) {
  const { grammar: text, notes } = schemaToGbnf(schema, options);
  const lint = lintGbnf(text);
  assert.deepEqual(lint.diagnostics, [], "generated grammar must lint clean");
  const { grammar: g } = parseGbnf(text);
  const compiled = compileGrammar(g);
  return {
    text,
    notes,
    accepts: (doc) =>
      matchText(compiled, typeof doc === "string" ? doc : JSON.stringify(doc)).outcome === "match",
  };
}

test("primitive types accept their JSON forms and nothing else", () => {
  const str = convert({ type: "string" });
  assert.ok(str.accepts('"hello \\u00e9\\n"'));
  assert.ok(!str.accepts("42"));
  const num = convert({ type: "number" });
  for (const ok of ["0", "-1.5", "12.25e-3", "1e4"]) assert.ok(num.accepts(ok), ok);
  for (const bad of ["01", "+1", ".5", '"x"']) assert.ok(!num.accepts(bad), bad);
  const int = convert({ type: "integer" });
  assert.ok(int.accepts("-12"));
  assert.ok(!int.accepts("1.5"));
  const bool = convert({ type: "boolean" });
  assert.ok(bool.accepts("true") && bool.accepts("false") && !bool.accepts("null"));
  assert.ok(convert({ type: "null" }).accepts("null"));
});

test("enum and const compile to exact literals", () => {
  const en = convert({ enum: ["red", "green", 7, null] });
  for (const ok of ['"red"', '"green"', "7", "null"]) assert.ok(en.accepts(ok), ok);
  assert.ok(!en.accepts('"blue"'));
  const c = convert({ const: { a: 1 } });
  assert.ok(c.accepts('{"a":1}'));
  assert.ok(!c.accepts('{"a":2}'));
});

test("objects require required properties in declaration order", () => {
  const conv = convert({
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "boolean" } },
    required: ["a", "b"],
  });
  assert.ok(conv.accepts({ a: 1, b: true }));
  assert.ok(!conv.accepts('{"b":true,"a":1}')); // fixed order, documented
  assert.ok(!conv.accepts('{"a":1}'));
});

test("optional properties may be omitted but keep their order", () => {
  const conv = convert({
    type: "object",
    properties: { a: { type: "integer" }, b: { type: "boolean" }, c: { type: "null" } },
    required: ["a"],
  });
  assert.ok(conv.accepts({ a: 1 }));
  assert.ok(conv.accepts({ a: 1, b: false }));
  assert.ok(conv.accepts({ a: 1, c: null }));
  assert.ok(conv.accepts({ a: 1, b: true, c: null }));
  assert.ok(!conv.accepts('{"a":1,"c":null,"b":true}'));
});

test("an all-optional object accepts every in-order subset including {}", () => {
  const conv = convert({
    type: "object",
    properties: { x: { type: "integer" }, y: { type: "integer" } },
  });
  for (const doc of [{}, { x: 1 }, { y: 2 }, { x: 1, y: 2 }]) {
    assert.ok(conv.accepts(doc), JSON.stringify(doc));
  }
  assert.ok(!conv.accepts('{"y":2,"x":1}'));
});

test("nested objects and arrays compose; pretty-printed JSON is accepted", () => {
  const conv = convert({
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      scores: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 3 },
    },
    required: ["user", "scores"],
  });
  assert.ok(conv.accepts({ user: { name: "ada" }, scores: [1, 2] }));
  assert.ok(conv.accepts(JSON.stringify({ user: { name: "ada" }, scores: [1] }, null, 2)));
  assert.ok(!conv.accepts({ user: {}, scores: [1] }));
  assert.ok(!conv.accepts({ user: { name: "ada" }, scores: [] }));
  assert.ok(!conv.accepts({ user: { name: "ada" }, scores: [1, 2, 3, 4] }));
});

test("array minItems/maxItems edge cases: empty-only and exactly-one", () => {
  const empty = convert({ type: "array", maxItems: 0 });
  assert.ok(empty.accepts([]));
  assert.ok(!empty.accepts([1]));
  const one = convert({ type: "array", items: { type: "integer" }, minItems: 1, maxItems: 1 });
  assert.ok(one.accepts([7]));
  assert.ok(!one.accepts([]) && !one.accepts([7, 8]));
});

test("prefixItems builds a tuple; items:false forbids extras", () => {
  const tuple = convert({ prefixItems: [{ type: "string" }, { type: "integer" }], items: false });
  assert.ok(tuple.accepts(["x", 3]));
  assert.ok(!tuple.accepts(["x", 3, true]));
  const open = convert({ prefixItems: [{ type: "string" }] });
  assert.ok(open.accepts(["x", 1, null])); // extras default to any value
});

test("anyOf and type arrays union branches; oneOf converts with a note", () => {
  const conv = convert({ anyOf: [{ type: "integer" }, { type: "boolean" }] });
  assert.ok(conv.accepts("5") && conv.accepts("true") && !conv.accepts('"s"'));
  const one = convert({ oneOf: [{ type: "integer" }, { type: "null" }] });
  assert.ok(one.accepts("null"));
  assert.ok(one.notes.some((n) => n.includes("oneOf")));
  const multi = convert({ type: ["string", "null"] });
  assert.ok(multi.accepts('"x"') && multi.accepts("null") && !multi.accepts("1"));
});

test("allOf merges object schemas: properties and required union", () => {
  const conv = convert({
    allOf: [
      { type: "object", properties: { a: { type: "integer" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "boolean" } }, required: ["b"] },
    ],
  });
  assert.ok(conv.accepts({ a: 1, b: true }));
  assert.ok(!conv.accepts({ a: 1 }));
  assert.throws(() => schemaToGbnf({ allOf: [{ type: "integer" }] }), SchemaError);
});

test("$ref resolves local pointers, including recursive schemas", () => {
  const conv = convert({
    $defs: {
      node: {
        type: "object",
        properties: {
          v: { type: "integer" },
          kids: { type: "array", items: { $ref: "#/$defs/node" } },
        },
        required: ["v"],
      },
    },
    $ref: "#/$defs/node",
  });
  assert.ok(conv.accepts({ v: 1, kids: [{ v: 2, kids: [] }, { v: 3 }] }));
  assert.ok(!conv.accepts({ kids: [] }));
  assert.throws(() => schemaToGbnf({ $ref: "#/nope" }), SchemaError);
  assert.throws(() => schemaToGbnf({ $ref: "https://example.test/s.json" }), SchemaError);
});

test("string bounds count characters; format uuid/date-time are structured", () => {
  const conv = convert({ type: "string", minLength: 2, maxLength: 3 });
  assert.ok(!conv.accepts('"a"'));
  assert.ok(conv.accepts('"ab"') && conv.accepts('"abc"'));
  assert.ok(!conv.accepts('"abcd"'));
  const uuid = convert({ type: "string", format: "uuid" });
  assert.ok(uuid.accepts('"123e4567-e89b-12d3-a456-426614174000"'));
  assert.ok(!uuid.accepts('"123e4567"'));
  const dt = convert({ type: "string", format: "date-time" });
  assert.ok(dt.accepts('"2026-07-12T09:30:00Z"'));
  assert.ok(dt.accepts('"2026-02-01T23:59:59.999+09:00"'));
  assert.ok(!dt.accepts('"2026-13-01T00:00:00Z"'));
});

test("unsupported keywords produce notes, metadata stays silent", () => {
  const conv = convert({
    type: "integer",
    minimum: 0,
    title: "Count",
    description: "ignored quietly",
  });
  assert.equal(conv.notes.length, 1);
  assert.match(conv.notes[0], /"minimum" at #/);
  const fmt = convert({ type: "string", format: "email" });
  assert.ok(fmt.notes.some((n) => n.includes('"format": "email"')));
});

test("additionalProperties: schema without properties is a typed map", () => {
  const conv = convert({ type: "object", additionalProperties: { type: "integer" } });
  assert.ok(conv.accepts({}) && conv.accepts({ a: 1, b: 2 }));
  assert.ok(!conv.accepts({ a: "x" }));
  const sealed = convert({ type: "object", additionalProperties: false });
  assert.ok(sealed.accepts({}) && !sealed.accepts({ a: 1 }));
});

test("compact mode emits no whitespace rules; output is deterministic", () => {
  const conv = convert(
    { type: "object", properties: { a: { type: "integer" } }, required: ["a"] },
    { compact: true }
  );
  assert.ok(!conv.text.includes("ws ::="));
  assert.ok(conv.accepts('{"a":1}'));
  assert.ok(!conv.accepts('{ "a": 1 }')); // compact means compact
  const schema = { type: "array", items: { enum: ["x", "y"] } };
  assert.equal(schemaToGbnf(schema).grammar, schemaToGbnf(schema).grammar);
});

test("untyped schemas fall back to any-JSON-value", () => {
  const conv = convert({});
  for (const ok of ['"s"', "3.5", "true", "null", "[1,[2]]", '{"k":{"n":[false]}}']) {
    assert.ok(conv.accepts(ok), ok);
  }
  assert.ok(!conv.accepts("undefined"));
});

test("impossible schemas fail loudly with SchemaError", () => {
  assert.throws(() => schemaToGbnf(false), SchemaError);
  assert.throws(() => schemaToGbnf({ type: "array", minItems: 3, maxItems: 1 }), SchemaError);
  assert.throws(() => schemaToGbnf({ type: "string", minLength: 5, maxLength: 2 }), SchemaError);
  assert.throws(() => schemaToGbnf({ type: "teapot" }), SchemaError);
  assert.throws(() => schemaToGbnf({ enum: [] }), SchemaError);
});
