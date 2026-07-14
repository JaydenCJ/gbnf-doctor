/**
 * The GBNF linter: 8 errors (E001-E008) and 7 warnings (W101-W107), each
 * with a stable code that never changes meaning. Errors describe grammars
 * llama.cpp will refuse to load or that can never match; warnings describe
 * grammars that load fine but almost certainly do not do what the author
 * intended. Rationale for every rule lives in docs/rules.md.
 */

import {
  computeNullable,
  computeProductive,
  leftRecursionCycles,
  nodeNullable,
  reachableRules,
  undefinedRefs,
  walkNodes,
} from "./analysis.js";
import { parseGbnf } from "./parse.js";
import { printSeq } from "./print.js";
import type {
  Diagnostic,
  GbnfNode,
  Grammar,
  LintResult,
  Pos,
  Rep,
  Rule,
  Severity,
} from "./types.js";

/** Every semantic lint rule, for docs, tests and `--format json` consumers. */
export const LINT_RULES: Record<string, { severity: Severity; summary: string }> = {
  E001: { severity: "error", summary: 'no "root" rule defined' },
  E002: { severity: "error", summary: "reference to an undefined rule" },
  E003: { severity: "error", summary: "duplicate rule definition" },
  E004: { severity: "error", summary: "left recursion" },
  E005: { severity: "error", summary: "empty character class" },
  E006: { severity: "error", summary: "reversed character range" },
  E007: { severity: "error", summary: "repetition with min greater than max" },
  E008: { severity: "error", summary: "rule can never match a finite string" },
  W101: { severity: "warning", summary: "rule unreachable from root" },
  W102: { severity: "warning", summary: "grammar accepts the empty string" },
  W103: { severity: "warning", summary: "duplicate alternative" },
  W104: { severity: "warning", summary: "overlapping character-class members" },
  W105: { severity: "warning", summary: "unbounded repetition over a nullable element" },
  W106: { severity: "warning", summary: "empty literal" },
  W107: { severity: "warning", summary: "generation can trail off in an unbounded repetition" },
};

/** Lint GBNF text: parse (a parse error is the single finding) then lint. */
export function lintGbnf(src: string): LintResult {
  const { grammar, error } = parseGbnf(src);
  if (grammar === null) {
    return summarize([error as Diagnostic]);
  }
  return summarize(lintGrammar(grammar));
}

/** Lint an already-parsed grammar. Returns findings sorted by position. */
export function lintGrammar(g: Grammar): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (code: string, pos: Pos, message: string): void => {
    const meta = LINT_RULES[code] as { severity: Severity };
    out.push({ code, severity: meta.severity, message, line: pos.line, col: pos.col });
  };

  const rootRule = g.rules.get("root");
  const nullable = computeNullable(g);

  // E001 — llama.cpp resolves the entry point by the literal name "root".
  if (!rootRule) {
    push("E001", { offset: 0, line: 1, col: 1 },
      'no "root" rule defined — llama.cpp requires the entry rule to be named "root"');
  }

  // E003 — later definitions silently replace earlier ones at load time.
  const firstDef = new Map<string, Rule>();
  for (const def of g.defs) {
    const first = firstDef.get(def.name);
    if (first === undefined) {
      firstDef.set(def.name, def);
    } else {
      push("E003", def.pos,
        `duplicate definition of rule "${def.name}" (first defined at line ${first.pos.line}) — llama.cpp silently keeps only the last definition`);
    }
  }

  // E002 — llama.cpp aborts with "undefined rule identifier".
  const defined = [...g.rules.keys()];
  for (const { name, pos } of undefinedRefs(g)) {
    const hint = suggest(name, defined);
    push("E002", pos,
      `undefined rule "${name}"${hint === null ? "" : ` (did you mean "${hint}"?)`}`);
  }

  // E004 — llama.cpp rejects left-recursive grammars at load time.
  for (const cycle of leftRecursionCycles(g)) {
    const first = g.rules.get(cycle[0] as string) as Rule;
    const path = [...cycle, cycle[0] as string].join(" -> ");
    push("E004", first.pos,
      `left recursion detected (${path}) — llama.cpp rejects left-recursive grammars at load time; rewrite with right recursion or repetition`);
  }

  // Per-node checks: E005, E006, E007, W104, W105, W106.
  for (const def of g.defs) {
    for (const node of walkNodes(def)) {
      checkNode(node, nullable, push);
    }
  }

  // E008 — the rule can start matching but no derivation ever finishes.
  const productive = computeProductive(g);
  for (const name of g.order) {
    if (!productive.has(name)) {
      const rule = g.rules.get(name) as Rule;
      push("E008", rule.pos,
        `rule "${name}" can never match: no alternative derives a finite string (missing base case or empty terminal)`);
    }
  }

  // W101 — dead rules; skipped entirely when there is no root to reach from.
  if (rootRule) {
    const reachable = reachableRules(g);
    for (const name of g.order) {
      if (!reachable.has(name)) {
        const rule = g.rules.get(name) as Rule;
        push("W101", rule.pos, `rule "${name}" is defined but unreachable from "root"`);
      }
    }
  }

  // W102 — the model may emit nothing at all and still satisfy the grammar.
  if (rootRule && nullable.has("root")) {
    push("W102", rootRule.pos,
      "the grammar accepts the empty string — constrained generation may finish without emitting anything");
  }

  // W103 — identical alternatives are dead weight and usually a typo.
  for (const [name, rule] of g.rules) {
    const seen = new Set<string>();
    for (const seq of rule.alts) {
      const key = printSeq(seq);
      const pos = seq.length > 0 ? (seq[0] as GbnfNode).pos : rule.pos;
      if (seen.has(key)) {
        push("W103", pos, `duplicate alternative ${key} in rule "${name}"`);
      } else {
        seen.add(key);
      }
    }
  }

  // W107 — nothing after the repetition ever forces generation to stop.
  if (rootRule) {
    for (const rep of trailingUnboundedReps(g, rootRule, nullable)) {
      push("W107", rep.pos,
        "unbounded repetition can end the generation — the grammar never forces a stop, so the model alone decides when to end");
    }
  }

  out.sort((a, b) => a.line - b.line || a.col - b.col || a.code.localeCompare(b.code));
  return out;
}

function checkNode(
  node: GbnfNode,
  nullable: Set<string>,
  push: (code: string, pos: Pos, message: string) => void
): void {
  if (node.kind === "class") {
    if (!node.negated && node.items.length === 0) {
      push("E005", node.pos, 'empty character class "[]" can never match');
    }
    for (const item of node.items) {
      if (item.lo > item.hi) {
        push("E006", node.pos,
          `reversed character range "${item.text}" (start is greater than end) can never match`);
      }
    }
    const valid = node.items
      .filter((i) => i.lo <= i.hi)
      .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    let maxHi = -1;
    for (const item of valid) {
      if (item.lo <= maxHi) {
        push("W104", node.pos,
          `character class has overlapping or duplicate members (e.g. "${item.text}")`);
        break;
      }
      maxHi = Math.max(maxHi, item.hi);
    }
  } else if (node.kind === "lit") {
    if (node.value.length === 0) {
      push("W106", node.pos, 'empty literal "" matches nothing and can be removed');
    }
  } else if (node.kind === "rep") {
    if (node.max !== null && node.min > node.max) {
      push("E007", node.pos,
        `repetition {${node.min},${node.max}} has min greater than max and can never match`);
    }
    if (node.max === null && nodeNullable(node.item, nullable)) {
      push("W105", node.pos,
        "unbounded repetition over an element that can match the empty string — iterations can succeed without consuming input");
    }
  }
}

/**
 * Collect every unbounded repetition that can be the last thing the
 * grammar matches: from the end of each root alternative, walk backwards
 * through nullable elements and descend into groups, repetitions and rule
 * references. These are the spots where generation "trails off".
 */
function trailingUnboundedReps(
  g: Grammar,
  root: Rule,
  nullable: Set<string>
): Rep[] {
  const found = new Set<Rep>();
  const out: Rep[] = [];
  const visitedRules = new Set<string>(["root"]);

  const finalNode = (node: GbnfNode): void => {
    switch (node.kind) {
      case "rep":
        if (node.max === null && !found.has(node)) {
          found.add(node);
          out.push(node);
        }
        finalNode(node.item); // the last iteration's tail is also final
        break;
      case "group":
        for (const seq of node.alts) finalSeq(seq);
        break;
      case "ref": {
        const rule = g.rules.get(node.name);
        if (rule && !visitedRules.has(node.name)) {
          visitedRules.add(node.name);
          for (const seq of rule.alts) finalSeq(seq);
        }
        break;
      }
      default:
        break;
    }
  };

  const finalSeq = (seq: GbnfNode[]): void => {
    for (let i = seq.length - 1; i >= 0; i--) {
      const node = seq[i] as GbnfNode;
      finalNode(node);
      if (!nodeNullable(node, nullable)) break;
    }
  };

  for (const seq of root.alts) finalSeq(seq);
  return out;
}

/** Nearest defined name within edit distance 2, for E002 hints. */
function suggest(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestDist = 3;
  for (const cand of candidates) {
    if (cand === name) continue;
    const dist = editDistance(name, cand, bestDist);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, sub);
    }
    prev = cur;
  }
  return Math.min(prev[b.length] as number, cap);
}

function summarize(diagnostics: Diagnostic[]): LintResult {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else warnings++;
  }
  return { diagnostics, errors, warnings, ok: errors === 0 };
}
