/**
 * gbnf-doctor public API. Everything the CLI does is available as pure
 * functions over strings — no file handles, no globals, no network — so
 * grammars can be linted, matched and generated inside other tools.
 */

export { parseGbnf, GbnfSyntaxError, PARSE_CODES } from "./parse.js";
export { lintGbnf, lintGrammar, LINT_RULES } from "./lint.js";
export {
  compileGrammar,
  matchText,
  matchGbnf,
  GrammarCompileError,
  MatchBudgetError,
  showCp,
} from "./match.js";
export type { CompiledGrammar, MatchOptions } from "./match.js";
export { schemaToGbnf, SchemaError } from "./schema.js";
export type { ConvertOptions, ConvertResult } from "./schema.js";
export { printGrammar, printRule, printSeq, printNode, quoteLit } from "./print.js";
export {
  computeNullable,
  computeProductive,
  reachableRules,
  undefinedRefs,
  leftRecursionCycles,
  walkNodes,
} from "./analysis.js";
export { VERSION } from "./version.js";
export type {
  AnyChar,
  CharClass,
  ClassItem,
  Diagnostic,
  GbnfNode,
  Grammar,
  Group,
  Lit,
  LintResult,
  MatchOutcome,
  MatchResult,
  ParseResult,
  Pos,
  Ref,
  Rep,
  Rule,
  Severity,
} from "./types.js";
