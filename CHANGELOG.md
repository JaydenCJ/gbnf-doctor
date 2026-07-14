# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-12

### Added

- `gbnf-doctor lint`: static analysis for GBNF grammars with 24 stable
  diagnostic codes — 9 parse errors (P001–P009) with fix-it hints for the
  classic mistakes (leading `|` continuation, `\-` escapes, stray `::=`),
  8 errors (E001–E008: missing root, undefined references with
  did-you-mean hints, duplicate definitions, left-recursion cycles, empty
  classes, reversed ranges, impossible bounds, rules that can never
  finish) and 7 warnings (W101–W107: unreachable rules, nullable root,
  duplicate alternatives, overlapping class members, repetition-over-empty
  loops, empty literals, trail-off repetitions). `--strict` and
  `--format json` included.
- `gbnf-doctor test`: matches strings against a grammar with the same
  breadth-first stack machine the llama.cpp sampler uses — no model
  loaded. Rejections report offset, line/col, the offending character and
  the merged set of characters the grammar expected; valid-but-unfinished
  input is reported as INCOMPLETE (accepted under `--prefix-ok`, for
  checking streamed output). `--file`, `--stdin`, `--chomp`,
  `--format json`.
- `gbnf-doctor convert`: JSON Schema to GBNF — types, `enum`/`const`,
  objects with required/optional properties, `additionalProperties` maps,
  arrays with `minItems`/`maxItems`, `prefixItems` tuples,
  `minLength`/`maxLength`, `format` uuid/date/time/date-time,
  `anyOf`/`oneOf`/`allOf`, recursive local `$ref`. Unsupported keywords
  become stderr notes (`--strict` fails on them); `--compact` drops
  whitespace rules; every generated grammar passes the bundled linter.
- Parser faithful to the llama.cpp loader: identical newline rules,
  escape set, repetition binding (`"ab"*` repeats the whole literal) and
  last-definition-wins semantics; deliberately stricter about raw
  newlines inside literals/classes (P003/P004 instead of silent
  swallowing).
- Canonical printer whose output re-parses to a fixpoint and only uses
  spellings llama.cpp accepts (`\x2D` for literal `-` in classes).
- Script-friendly exit codes (0 ok / 1 findings or rejections / 2 usage
  or input error) shared by all subcommands.
- Public programmatic API (`parseGbnf`, `lintGbnf`, `compileGrammar`,
  `matchText`, `schemaToGbnf`, `printGrammar`, grammar analyses) with
  type declarations.
- Test suite: 90 node:test tests (unit + CLI integration in fresh temp
  dirs) and an end-to-end `scripts/smoke.sh` against the bundled
  examples.

[0.1.0]: https://github.com/JaydenCJ/gbnf-doctor/releases/tag/v0.1.0
