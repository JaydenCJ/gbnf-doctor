/**
 * The match engine: tests a string against a grammar with the same
 * breadth-first stack machine llama.cpp uses at sampling time — a set of
 * possible continuation stacks advanced one code point at a time, with
 * duplicate stacks pruned each step. On rejection it reports the exact
 * position of the first impossible character plus the set of characters
 * the grammar would have accepted there; a valid-but-unfinished string is
 * reported as "incomplete" (useful for checking streamed output).
 *
 * The same grammars llama.cpp refuses to load are refused here with the
 * same reasons (missing root, undefined rules, left recursion), so a
 * grammar that passes `compileGrammar` will also load in llama.cpp.
 */

import { leftRecursionCycles, undefinedRefs } from "./analysis.js";
import type { GbnfNode, Grammar, MatchResult } from "./types.js";

/** Thrown when a grammar cannot be compiled; `code` matches the lint rule. */
export class GrammarCompileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GrammarCompileError";
    this.code = code;
  }
}

/** Thrown when matching exceeds its work budget (pathological ambiguity). */
export class MatchBudgetError extends Error {
  constructor() {
    super(
      "match aborted: the grammar is too ambiguous to test within the work budget"
    );
    this.name = "MatchBudgetError";
  }
}

type Terminal =
  | { t: "term"; id: number; neg: boolean; ranges: [number, number][] }
  | { t: "any"; id: number };

type MElem =
  | Terminal
  | { t: "ref"; id: number; name: string }
  | { t: "alt"; id: number; opts: MElem[][] }
  | { t: "rep"; id: number; item: MElem; min: number; max: number | null };

type RepElem = Extract<MElem, { t: "rep" }>;

export interface CompiledGrammar {
  rules: Map<string, MElem[][]>;
  start: MElem;
}

/**
 * Compile a parsed grammar for matching. Refuses exactly the grammars
 * llama.cpp refuses to load: no root (E001), undefined references (E002),
 * left recursion (E004).
 */
export function compileGrammar(g: Grammar): CompiledGrammar {
  if (!g.rules.has("root")) {
    throw new GrammarCompileError("E001", 'no "root" rule defined');
  }
  const undef = undefinedRefs(g);
  if (undef.length > 0) {
    const names = [...new Set(undef.map((u) => u.name))].join('", "');
    throw new GrammarCompileError("E002", `undefined rule(s): "${names}"`);
  }
  const cycles = leftRecursionCycles(g);
  if (cycles.length > 0) {
    const cycle = cycles[0] as string[];
    const path = [...cycle, cycle[0] as string].join(" -> ");
    throw new GrammarCompileError(
      "E004",
      `left recursion detected (${path}) — llama.cpp also rejects this grammar; rewrite with right recursion or repetition`
    );
  }

  let nextId = 0;
  const id = (): number => nextId++;

  const normalize = (node: GbnfNode): MElem => {
    switch (node.kind) {
      case "lit": {
        const cps = [...node.value].map((c) => c.codePointAt(0) as number);
        if (cps.length === 1) {
          const cp = cps[0] as number;
          return { t: "term", id: id(), neg: false, ranges: [[cp, cp]] };
        }
        // Multi-char literals become a single-option alternation so a
        // repetition of the literal repeats the whole thing, as llama.cpp
        // does; the empty literal is a sequence of zero elements.
        return { t: "alt", id: id(), opts: [cps.map((cp) => ({
          t: "term" as const, id: id(), neg: false,
          ranges: [[cp, cp]] as [number, number][],
        }))] };
      }
      case "class": {
        // Reversed ranges match nothing; dropping them here keeps the
        // semantics identical for both plain and negated classes.
        const ranges = node.items
          .filter((i) => i.lo <= i.hi)
          .map((i): [number, number] => [i.lo, i.hi]);
        return { t: "term", id: id(), neg: node.negated, ranges };
      }
      case "any":
        return { t: "any", id: id() };
      case "ref":
        return { t: "ref", id: id(), name: node.name };
      case "group":
        return { t: "alt", id: id(), opts: node.alts.map((seq) => seq.map(normalize)) };
      case "rep":
        return { t: "rep", id: id(), item: normalize(node.item), min: node.min, max: node.max };
    }
  };

  const rules = new Map<string, MElem[][]>();
  for (const [name, rule] of g.rules) {
    rules.set(name, rule.alts.map((seq) => seq.map(normalize)));
  }
  const start: MElem = { t: "ref", id: id(), name: "root" };
  return { rules, start };
}

// --- the stack machine ----------------------------------------------------

type Frame =
  | { k: "e"; e: MElem }
  | { k: "rep"; rep: RepElem; count: number };

interface StackNode {
  frame: Frame;
  next: StackNode | null;
  key: string;
}

function frameKey(frame: Frame): string {
  return frame.k === "e" ? `e${frame.e.id}` : `r${frame.rep.id}:${frame.count}`;
}

function push(frame: Frame, next: StackNode | null): StackNode {
  const key = frameKey(frame) + (next === null ? "" : ";" + next.key);
  return { frame, next, key };
}

function pushSeq(next: StackNode | null, items: MElem[]): StackNode | null {
  let stack = next;
  for (let i = items.length - 1; i >= 0; i--) {
    stack = push({ k: "e", e: items[i] as MElem }, stack);
  }
  return stack;
}

interface ExpandState {
  /** Stacks whose top frame is a terminal, ready to consume a character. */
  ready: StackNode[];
  /** True when some stack emptied completely: the input so far is a match. */
  accepted: boolean;
}

function expand(
  cg: CompiledGrammar,
  stacks: (StackNode | null)[],
  budget: { ops: number }
): ExpandState {
  const ready: StackNode[] = [];
  const seen = new Set<string>();
  let accepted = false;
  const work = [...stacks];
  while (work.length > 0) {
    if (--budget.ops < 0) throw new MatchBudgetError();
    const stack = work.pop() as StackNode | null;
    const key = stack === null ? "" : stack.key;
    if (seen.has(key)) continue;
    seen.add(key);
    if (stack === null) {
      accepted = true;
      continue;
    }
    const frame = stack.frame;
    if (frame.k === "e") {
      const e = frame.e;
      switch (e.t) {
        case "term":
        case "any":
          ready.push(stack);
          break;
        case "ref":
          for (const opt of cg.rules.get(e.name) as MElem[][]) {
            work.push(pushSeq(stack.next, opt));
          }
          break;
        case "alt":
          for (const opt of e.opts) {
            work.push(pushSeq(stack.next, opt));
          }
          break;
        case "rep":
          work.push(push({ k: "rep", rep: e, count: 0 }, stack.next));
          break;
      }
    } else {
      const { rep, count } = frame;
      if (count >= rep.min) {
        work.push(stack.next); // enough iterations: continue past the rep
      }
      if (rep.max === null || count < rep.max) {
        // For unbounded repetitions every count >= min behaves the same,
        // so the counter saturates at min. This makes stack keys stabilize
        // and guarantees termination even for reps over nullable items.
        const nextCount = rep.max === null ? Math.min(count + 1, rep.min) : count + 1;
        work.push(
          push({ k: "e", e: rep.item }, push({ k: "rep", rep, count: nextCount }, stack.next))
        );
      }
    }
  }
  return { ready, accepted };
}

/** Top frame of a ready stack — expand() guarantees it is a terminal. */
function topTerminal(stack: StackNode): Terminal {
  return (stack.frame as Extract<Frame, { k: "e" }>).e as Terminal;
}

function terminalMatches(e: Terminal, cp: number): boolean {
  if (e.t === "any") return true;
  const inRanges = e.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
  return e.neg ? !inRanges : inRanges;
}

/** Options for {@link matchText}. */
export interface MatchOptions {
  /** Stack-machine work budget; the default is ample for real grammars. */
  budget?: number;
}

/** Test `text` against a compiled grammar, one code point at a time. */
export function matchText(
  cg: CompiledGrammar,
  text: string,
  options?: MatchOptions
): MatchResult {
  const budget = { ops: options?.budget ?? 200_000 };
  let state = expand(cg, [push({ k: "e", e: cg.start }, null)], budget);
  let offset = 0;
  let line = 1;
  let col = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const next: (StackNode | null)[] = [];
    for (const stack of state.ready) {
      if (terminalMatches(topTerminal(stack), cp)) {
        next.push(stack.next);
      }
    }
    if (next.length === 0) {
      return {
        outcome: "nomatch",
        offset,
        line,
        col,
        got: ch,
        expected: describeExpected(state.ready, state.accepted),
      };
    }
    state = expand(cg, next, budget);
    offset++;
    if (ch === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  if (state.accepted) {
    return { outcome: "match", offset, line, col, got: null, expected: [] };
  }
  return {
    outcome: "incomplete",
    offset,
    line,
    col,
    got: null,
    expected: describeExpected(state.ready, false),
  };
}

/** Convenience: parse + compile + match in one call (used by the library). */
export function matchGbnf(
  grammar: Grammar,
  text: string,
  options?: MatchOptions
): MatchResult {
  return matchText(compileGrammar(grammar), text, options);
}

// --- human-readable expectations -------------------------------------------

function describeExpected(ready: StackNode[], accepted: boolean): string[] {
  let anySeen = false;
  const positive: [number, number][] = [];
  const negated = new Set<string>();
  for (const stack of ready) {
    const e = topTerminal(stack);
    if (e.t === "any") {
      anySeen = true;
    } else if (e.neg) {
      negated.add(`any character except ${formatRanges(e.ranges)}`);
    } else {
      positive.push(...e.ranges);
    }
  }
  if (anySeen) return ["any character"];
  const labels: string[] = [];
  if (positive.length > 0) labels.push(...rangeLabels(mergeRanges(positive)));
  labels.push(...[...negated].sort());
  if (labels.length === 0) {
    return [accepted ? "end of input" : "nothing (the grammar cannot continue)"];
  }
  if (labels.length > 12) {
    const extra = labels.length - 12;
    return [...labels.slice(0, 12), `... (${extra} more)`];
  }
  return labels;
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged;
}

function rangeLabels(ranges: [number, number][]): string[] {
  return ranges.map(([lo, hi]) =>
    lo === hi ? showCp(lo) : `${showCp(lo)}-${showCp(hi)}`
  );
}

function formatRanges(ranges: [number, number][]): string {
  if (ranges.length === 0) return "nothing";
  return rangeLabels(mergeRanges(ranges)).join(", ");
}

/** Render one code point the way a human wants to read it in an error. */
export function showCp(cp: number): string {
  if (cp === 0x0a) return '"\\n"';
  if (cp === 0x0d) return '"\\r"';
  if (cp === 0x09) return '"\\t"';
  if (cp === 0x22) return '"\\""';
  if (cp === 0x5c) return '"\\\\"';
  if (cp < 0x20 || cp === 0x7f) {
    return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  }
  return `"${String.fromCodePoint(cp)}"`;
}
