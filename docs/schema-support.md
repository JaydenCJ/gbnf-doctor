# JSON Schema support in `convert`

The converter targets the subset of JSON Schema that a context-free
grammar can honestly express. Everything else is surfaced as a `note:` on
stderr (never silently dropped); `--strict` turns any note into exit 1.

## Supported keywords

| Keyword | Handling |
|---|---|
| `type` | `string`, `number`, `integer`, `boolean`, `null`, `object`, `array`; an array of types becomes an alternation |
| `enum`, `const` | exact JSON literals |
| `properties`, `required` | required properties in declaration order, then optional properties in declaration order (see below) |
| `additionalProperties` | `false` (and the default) seals the object; a schema or `true` **without** `properties` produces a typed free-form map |
| `items` | element schema; `false` (or `maxItems: 0`) allows only `[]` |
| `prefixItems` | tuple; extra elements follow `items` (default: any JSON value; `items: false` forbids them) |
| `minItems`, `maxItems` | compiled into bounded repetition |
| `minLength`, `maxLength` | compiled into bounded `string-char` repetition |
| `format` | `uuid`, `date`, `time`, `date-time` become structured grammars; other formats are noted and fall back to plain `string` |
| `anyOf`, `oneOf` | alternation; `oneOf` gets a note because a grammar cannot enforce exclusivity |
| `allOf` | supported for object schemas: `properties` merged, `required` unioned |
| `$ref` | local (`#/...`) pointers, including recursive schemas (they become recursive rules) |
| metadata | `title`, `description`, `default`, `examples`, `$schema`, `$id`, `$comment`, … ignored silently |

## Noted-and-ignored keywords

`pattern`, `minimum`/`maximum`/`exclusive*`/`multipleOf`, `uniqueItems`,
`contains`, `minProperties`/`maxProperties`, `patternProperties`,
`propertyNames`, `not`, `if`/`then`/`else`, `dependent*` — plus
`additionalProperties` given alongside `properties`. Each occurrence
produces one note with its JSON-pointer path.

## Deliberate design choices

- **Fixed property order.** A grammar that accepted every permutation of
  n properties would need n! alternatives. The converter emits required
  properties in declaration order, then each optional property (in order)
  as an optional segment — the same trade-off the converter inside
  llama.cpp makes. Constrained generation *produces* JSON, so a fixed
  order costs nothing there; it only matters if you reuse the grammar as
  a validator for third-party JSON.
- **Bounded padding.** Inter-token whitespace is `[ \t\n\r]{0,16}` and
  numeric digit runs are capped (16 integer / 16 fraction / 4 exponent
  digits), so a model can never satisfy the grammar by padding forever.
  `--compact` removes inter-token whitespace entirely.
- **Self-checked output.** Every generated grammar is run through the
  bundled linter before it is written, and the test suite round-trips
  generated grammars through the match engine against accept/reject
  samples. If `convert` emits it, `lint` scores it clean and `test`
  agrees with the schema.
