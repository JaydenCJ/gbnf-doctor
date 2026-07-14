#!/usr/bin/env node
/**
 * The gbnf-doctor CLI: `lint`, `test` and `convert`.
 *
 * Exit codes, shared by every subcommand so scripts can tell a bad file
 * from a bad invocation:
 *   0  success
 *   1  findings (lint errors, rejected test strings, strict-mode notes)
 *   2  usage, I/O, or input errors (unreadable file, broken grammar
 *      passed to `test`, invalid schema JSON)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs, UsageError, type ParsedArgs } from "./cliargs.js";
import { lintGbnf } from "./lint.js";
import {
  compileGrammar,
  GrammarCompileError,
  MatchBudgetError,
  matchText,
} from "./match.js";
import { parseGbnf } from "./parse.js";
import { SchemaError, schemaToGbnf } from "./schema.js";
import type { MatchResult } from "./types.js";
import { VERSION } from "./version.js";

const HELP = `gbnf-doctor ${VERSION} — lint, test and generate GBNF grammars without loading a model

Usage:
  gbnf-doctor lint <grammar.gbnf> [--strict] [--format text|json]
  gbnf-doctor test <grammar.gbnf> [strings...] [--file <path>] [--stdin]
                   [--chomp] [--prefix-ok] [--format text|json]
  gbnf-doctor convert <schema.json> [--out <grammar.gbnf>] [--compact] [--strict]
  gbnf-doctor --help | --version

Commands:
  lint      Check a grammar for the mistakes that break constrained
            generation: parse errors, undefined rules, left recursion,
            dead rules, empty matches and more. --strict also fails on
            warnings.
  test      Match strings against a grammar with the same stack machine
            the runtime uses. Rejections report the exact offset plus the
            characters the grammar expected there. --prefix-ok accepts
            incomplete-but-valid prefixes (streamed output); --file/--stdin
            read the candidate text from a file or stdin; --chomp strips
            one trailing newline from it first.
  convert   Turn a JSON Schema into a GBNF grammar. Unsupported keywords
            are reported as notes on stderr; --strict turns notes into a
            failure. --compact omits inter-token whitespace rules.

Exit codes: 0 ok, 1 findings/rejections, 2 usage or input error.`;

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function errLine(line: string): void {
  process.stderr.write(line + "\n");
}

function readInput(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new UsageError(`cannot read "${path}": ${(e as Error).message}`);
  }
}

// --- lint -------------------------------------------------------------------

function jsonFormat(args: ParsedArgs): boolean {
  const format = args.flags["format"] ?? "text";
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be "text" or "json", got "${format}"`);
  }
  return format === "json";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function cmdLint(args: ParsedArgs): number {
  const [file, extra] = args.positionals;
  if (file === undefined || extra !== undefined) {
    throw new UsageError("lint takes exactly one grammar file");
  }
  const strict = args.flags["strict"] === true;
  const asJson = jsonFormat(args);
  const result = lintGbnf(readInput(file));
  const failed = result.errors > 0 || (strict && result.warnings > 0);
  if (asJson) {
    out(JSON.stringify({
      file,
      ok: !failed,
      errors: result.errors,
      warnings: result.warnings,
      findings: result.diagnostics,
    }, null, 2));
    return failed ? 1 : 0;
  }
  for (const d of result.diagnostics) {
    out(`${file}:${d.line}:${d.col}: ${d.severity} ${d.code} ${d.message}`);
  }
  const verdict = failed ? "FAIL" : "OK";
  out(`${file}: ${verdict} (${plural(result.errors, "error")}, ` +
    `${plural(result.warnings, "warning")})`);
  return failed ? 1 : 0;
}

// --- test -------------------------------------------------------------------

function showInput(text: string): string {
  const encoded = JSON.stringify(text);
  return encoded.length <= 48 ? encoded : encoded.slice(0, 47) + "…\"";
}

function cmdTest(args: ParsedArgs): number {
  const [file, ...candidates] = args.positionals;
  if (file === undefined) {
    throw new UsageError("test needs a grammar file");
  }
  const asJson = jsonFormat(args);
  const chomp = args.flags["chomp"] === true;
  const fromFile = args.flags["file"];
  if (typeof fromFile === "string") {
    candidates.push(maybeChomp(readInput(fromFile), chomp));
  }
  if (args.flags["stdin"] === true) {
    candidates.push(maybeChomp(readFileSync(0, "utf8"), chomp));
  }
  if (candidates.length === 0) {
    throw new UsageError("test needs at least one string (argument, --file or --stdin)");
  }

  const src = readInput(file);
  const { grammar, error } = parseGbnf(src);
  if (grammar === null) {
    const e = error as NonNullable<typeof error>;
    errLine(`${file}:${e.line}:${e.col}: error ${e.code} ${e.message}`);
    errLine(`${file}: grammar does not parse; run \`gbnf-doctor lint ${file}\``);
    return 2;
  }
  let compiled;
  try {
    compiled = compileGrammar(grammar);
  } catch (e) {
    if (e instanceof GrammarCompileError) {
      errLine(`${file}: error ${e.code} ${e.message}`);
      errLine(`${file}: grammar does not load; run \`gbnf-doctor lint ${file}\``);
      return 2;
    }
    throw e;
  }

  const prefixOk = args.flags["prefix-ok"] === true;
  const results: { input: string; result: MatchResult }[] = [];
  for (const input of candidates) {
    results.push({ input, result: matchText(compiled, input) });
  }
  const rejected = (r: MatchResult): boolean =>
    r.outcome === "nomatch" || (r.outcome === "incomplete" && !prefixOk);

  if (asJson) {
    out(JSON.stringify({
      file,
      ok: !results.some((r) => rejected(r.result)),
      results: results.map(({ input, result }) => ({ input, ...result })),
    }, null, 2));
  } else {
    for (const { input, result } of results) {
      if (result.outcome === "match") {
        out(`${file}: MATCH ${showInput(input)}`);
      } else if (result.outcome === "incomplete") {
        out(`${file}: INCOMPLETE ${showInput(input)} — valid prefix, ` +
          `but the grammar expects more: ${result.expected.join(" or ")}`);
      } else {
        out(`${file}: NO MATCH ${showInput(input)} — at offset ${result.offset} ` +
          `(line ${result.line}, col ${result.col}): got ${JSON.stringify(result.got)}, ` +
          `expected ${result.expected.join(" or ")}`);
      }
    }
  }
  return results.some((r) => rejected(r.result)) ? 1 : 0;
}

function maybeChomp(text: string, chomp: boolean): string {
  if (!chomp) return text;
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

// --- convert ------------------------------------------------------------------

function cmdConvert(args: ParsedArgs): number {
  const [file, extra] = args.positionals;
  if (file === undefined || extra !== undefined) {
    throw new UsageError("convert takes exactly one schema file");
  }
  let schema: unknown;
  try {
    schema = JSON.parse(readInput(file));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`"${file}" is not valid JSON: ${(e as Error).message}`);
  }
  const { grammar, notes } = schemaToGbnf(schema, {
    compact: args.flags["compact"] === true,
  });
  for (const note of notes) {
    errLine(`note: ${note}`);
  }
  if (args.flags["strict"] === true && notes.length > 0) {
    errLine(`strict mode: ${plural(notes.length, "unsupported keyword note")}; no grammar written`);
    return 1;
  }
  // Belt and braces: the converter's output contract is "lints clean".
  const check = lintGbnf(grammar);
  /* c8 ignore next 3 */
  if (check.errors > 0) {
    throw new Error("internal error: generated grammar failed its own lint");
  }
  const outPath = args.flags["out"];
  if (typeof outPath === "string") {
    writeFileSync(outPath, grammar);
    const ruleCount = grammar.split("\n").filter((l) => l.includes("::=")).length;
    out(`wrote ${outPath} (${plural(ruleCount, "rule")})`);
  } else {
    process.stdout.write(grammar);
  }
  return 0;
}

// --- entry point ----------------------------------------------------------------

/**
 * True when `--help` appears before any `--` end-of-flags marker. Only the
 * long spelling counts here: after a subcommand, `-h` stays available as a
 * literal positional (e.g. a candidate string for `test`).
 */
function wantsHelp(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help") return true;
  }
  return false;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== undefined && wantsHelp(rest)) {
    out(HELP);
    return 0;
  }
  try {
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
      case "help":
        out(HELP);
        return command === undefined ? 2 : 0;
      case "--version":
      case "-V":
        out(VERSION);
        return 0;
      case "lint":
        return cmdLint(parseArgs(rest, { strict: "boolean", format: "string" }));
      case "test":
        return cmdTest(parseArgs(rest, {
          file: "string",
          stdin: "boolean",
          chomp: "boolean",
          "prefix-ok": "boolean",
          format: "string",
        }));
      case "convert":
        return cmdConvert(parseArgs(rest, {
          out: "string",
          compact: "boolean",
          strict: "boolean",
        }));
      default:
        throw new UsageError(`unknown command "${command}" (try --help)`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof SchemaError || e instanceof MatchBudgetError) {
      errLine(`gbnf-doctor: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
