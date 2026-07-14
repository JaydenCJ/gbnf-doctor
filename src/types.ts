/**
 * Shared types for gbnf-doctor: the GBNF grammar AST, diagnostics, and
 * match results. All positions are 1-based (line, col) plus a 0-based
 * character offset, matching what editors and CI annotations expect.
 */

/** A source position. `offset` counts Unicode code points from the start. */
export interface Pos {
  offset: number;
  line: number;
  col: number;
}

/**
 * One member of a character class: a single code point (lo === hi) or an
 * inclusive range. `text` keeps the raw source spelling for diagnostics.
 */
export interface ClassItem {
  lo: number;
  hi: number;
  text: string;
}

/** A literal string, e.g. `"true"`. May span several code points. */
export interface Lit {
  kind: "lit";
  value: string;
  pos: Pos;
}

/** A character class, e.g. `[a-zA-Z0-9-]` or `[^"\\]`. */
export interface CharClass {
  kind: "class";
  negated: boolean;
  items: ClassItem[];
  pos: Pos;
}

/** The `.` wildcard: any single character. */
export interface AnyChar {
  kind: "any";
  pos: Pos;
}

/** A reference to another rule by name. */
export interface Ref {
  kind: "ref";
  name: string;
  pos: Pos;
}

/** A parenthesized group of alternatives, each alternative a sequence. */
export interface Group {
  kind: "group";
  alts: GbnfNode[][];
  pos: Pos;
}

/**
 * A repetition of a single element: `*` (0,null), `+` (1,null), `?` (0,1)
 * or `{m}` / `{m,}` / `{m,n}`. `max === null` means unbounded.
 */
export interface Rep {
  kind: "rep";
  item: GbnfNode;
  min: number;
  max: number | null;
  pos: Pos;
}

export type GbnfNode = Lit | CharClass | AnyChar | Ref | Group | Rep;

/** One `name ::= alternatives` definition. */
export interface Rule {
  name: string;
  alts: GbnfNode[][];
  pos: Pos;
}

/**
 * A parsed grammar. `defs` preserves every definition in source order
 * (including duplicates); `rules` maps each name to its *last* definition,
 * mirroring the "last definition wins" behavior of the llama.cpp loader.
 */
export interface Grammar {
  defs: Rule[];
  rules: Map<string, Rule>;
  order: string[];
}

export type Severity = "error" | "warning";

/** A single lint or parse finding with a stable code. */
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  line: number;
  col: number;
}

/** The result of linting one grammar text. */
export interface LintResult {
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  /** True when there are no error-severity findings. */
  ok: boolean;
}

/** The result of parsing: a grammar, or a single positioned parse error. */
export interface ParseResult {
  grammar: Grammar | null;
  error: Diagnostic | null;
}

export type MatchOutcome = "match" | "incomplete" | "nomatch";

/**
 * The result of testing one string against a grammar. For "nomatch",
 * `offset`/`line`/`col` locate the first character the grammar could not
 * accept, `got` is that character, and `expected` lists what the grammar
 * would have accepted there. For "incomplete" the string is a valid prefix
 * but the grammar still needs more input; `expected` lists what comes next.
 */
export interface MatchResult {
  outcome: MatchOutcome;
  offset: number;
  line: number;
  col: number;
  got: string | null;
  expected: string[];
}
