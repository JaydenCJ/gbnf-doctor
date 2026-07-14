# gbnf-doctor examples

Three small files that exercise all three verbs. Run everything from the
repository root after `npm install && npm run build`.

## ipv4.gbnf — a clean grammar to lint and test

```bash
node dist/cli.js lint examples/ipv4.gbnf
node dist/cli.js test examples/ipv4.gbnf "127.0.0.1" "256.1.1.1" "10.0"
```

`127.0.0.1` matches; `256.1.1.1` is rejected at offset 2 with the exact
characters the grammar would have accepted (`"." or "0"-"5"`); `10.0` is
reported as a valid-but-incomplete prefix (add `--prefix-ok` to accept it,
useful when checking a model's streamed output mid-generation).

## broken.gbnf — every classic mistake in one file

```bash
node dist/cli.js lint examples/broken.gbnf
```

Triggers E002 (undefined rule, with a did-you-mean hint), E004 (left
recursion, which llama.cpp refuses to load), W101 (unreachable rules) and
W103 (duplicate alternative). The rule reference for each code is in
[docs/rules.md](../docs/rules.md).

## ticket.schema.json — JSON Schema to GBNF

```bash
node dist/cli.js convert examples/ticket.schema.json --out ticket.generated.gbnf
node dist/cli.js lint ticket.generated.gbnf
node dist/cli.js test ticket.generated.gbnf \
  '{"id":"123e4567-e89b-12d3-a456-426614174000","title":"Printer on fire","priority":"high","resolved":false}'
```

A support-ticket schema with `format: uuid`, `minLength`/`maxLength`,
`enum`, a bounded array and a nested optional object. The generated
grammar always passes the bundled linter, and the matcher accepts exactly
the JSON documents the schema subset describes — see
[docs/schema-support.md](../docs/schema-support.md) for what is covered.
