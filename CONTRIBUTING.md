# Contributing to gbnf-doctor

Issues, discussions and pull requests are all welcome — this project aims
to stay small, zero-dependency at runtime, and faithful to what llama.cpp
actually loads.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/gbnf-doctor.git
cd gbnf-doctor
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 90 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check against examples/
```

`scripts/smoke.sh` exercises the real CLI (lint, test, convert, exit
codes, schema round-trip, idempotency) against the bundled examples and
must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable
   modules (parsing/linting/matching/conversion take strings, not file
   handles — only `cli.ts` touches the filesystem).
5. New lint rules need a row in `docs/rules.md`, a rationale, and at
   least one test; fidelity changes to the parser need a citation of the
   llama.cpp behavior they follow.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- No network calls, ever — the tool reads and writes local files only.
- Diagnostic codes (`P00x`/`E00x`/`W10x`) are stable API: never renumber
  or repurpose an existing code; add new ones instead.
- Generated grammars must keep the invariant: whatever `convert` emits,
  `lint` scores clean and `test` accepts/rejects per the schema.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `gbnf-doctor --version` output, the exact command line,
the smallest grammar (or schema) that reproduces the problem, and what
you expected. For matcher bugs, the input string and the reported
offset/expected set are the most useful artifacts; if llama.cpp treats
the same grammar differently, say which version.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
