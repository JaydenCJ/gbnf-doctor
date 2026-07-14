# Lint rule reference

Codes are stable API: a code never changes meaning or severity; new checks
get new codes. Errors (`E1xx` numbering not used — errors are `E00x`)
describe grammars llama.cpp refuses to load or that can never match;
warnings describe grammars that load fine but almost certainly misbehave
during constrained generation. Parse failures use `P00x` codes and always
abort with a single positioned finding.

## Parse errors (P001–P009)

| Code | Fires when | Notes |
|---|---|---|
| P001 | unexpected end of input | mid-rule, mid-group, mid-bounds |
| P002 | `::=` missing after a rule name | |
| P003 | unterminated string literal | also fires for a raw newline inside `"..."` — llama.cpp silently swallows it, which is almost always a missing quote; write `\n` instead |
| P004 | unterminated character class | same raw-newline policy as P003 |
| P005 | invalid escape sequence | valid set is exactly llama.cpp's: `\xHH \uHHHH \UHHHHHHHH \t \r \n \\ \" \[ \]`; `\-` gets a targeted hint (`\x2D`) |
| P006 | invalid repetition | `{,n}`, unclosed `{`, oversized bounds, or an operator with nothing to repeat |
| P007 | unexpected character | a stray `::=` mid-body gets a hint about trailing `\|` / missing newlines |
| P008 | a top-level line begins with `\|` | llama.cpp only supports *trailing* `\|` continuation; the message shows both fixes |
| P009 | invalid rule name | usually `_` — GBNF names are `[a-zA-Z0-9-]+` |

## Errors (E001–E008)

| Code | Fires when | Why it is an error |
|---|---|---|
| E001 | no `root` rule | llama.cpp resolves the entry point by the literal name `root` |
| E002 | reference to an undefined rule | load-time abort in llama.cpp; the finding includes a did-you-mean hint within edit distance 2 |
| E003 | duplicate rule definition | llama.cpp silently keeps only the **last** definition — the author's intent is ambiguous |
| E004 | left recursion (direct, indirect, or behind a nullable prefix) | llama.cpp rejects left-recursive grammars at load time; the finding prints the cycle |
| E005 | empty character class `[]` | matches nothing, so the containing rule can never match (`[^]` is fine: it matches any character) |
| E006 | reversed character range (`[z-a]`) | matches nothing |
| E007 | repetition `{m,n}` with `m > n` | can never match |
| E008 | rule can never finish matching | e.g. `a ::= "x" a` with no base case: every derivation recurses forever, so generation can never complete |

## Warnings (W101–W107)

| Code | Fires when | Why it matters |
|---|---|---|
| W101 | rule unreachable from `root` | dead weight; frequently the symptom of a typo that also raised E002 |
| W102 | the grammar accepts the empty string | the model may satisfy the grammar by emitting nothing |
| W103 | duplicate alternative in a rule | compared canonically, so `"a"` and `"a"` spelled with different whitespace still match |
| W104 | overlapping/duplicate character-class members | `[a-zA-Za-m]` — harmless to the engine, but usually an editing mistake |
| W105 | unbounded repetition over an element that can match empty | `("x"?)*` — iterations can succeed without consuming input; the intent is almost always `"x"*` |
| W106 | empty literal `""` | a no-op that usually marks an unfinished edit |
| W107 | unbounded repetition can be the last thing matched | nothing forces generation to stop, so the model alone decides when to end; add a terminator or a bound if that is not intended |

`lint` exits 1 when errors are present; `--strict` also fails on warnings.
Both text and `--format json` output carry the code, severity, message and
1-based line/column of every finding.
