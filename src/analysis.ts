/**
 * Pure grammar analyses shared by the linter and the match engine:
 * nullability, productivity, reachability, undefined references and
 * left-recursion detection. All fixpoints run over the *effective* rule
 * set (last definition per name), which is what llama.cpp loads.
 */

import type { GbnfNode, Grammar, Pos, Rule } from "./types.js";

/** Depth-first walk over every node in a rule body. */
export function* walkNodes(rule: Rule): Generator<GbnfNode> {
  for (const seq of rule.alts) {
    for (const node of seq) yield* walkNode(node);
  }
}

function* walkNode(node: GbnfNode): Generator<GbnfNode> {
  yield node;
  if (node.kind === "group") {
    for (const seq of node.alts) {
      for (const child of seq) yield* walkNode(child);
    }
  } else if (node.kind === "rep") {
    yield* walkNode(node.item);
  }
}

/** Can this node match the empty string, given the nullable rule set? */
export function nodeNullable(node: GbnfNode, nullable: Set<string>): boolean {
  switch (node.kind) {
    case "lit":
      return node.value.length === 0;
    case "class":
    case "any":
      return false; // always consumes exactly one character
    case "ref":
      return nullable.has(node.name);
    case "group":
      return node.alts.some((seq) => seqNullable(seq, nullable));
    case "rep":
      return node.min === 0 || nodeNullable(node.item, nullable);
  }
}

function seqNullable(seq: GbnfNode[], nullable: Set<string>): boolean {
  return seq.every((node) => nodeNullable(node, nullable));
}

/** Fixpoint: the set of rule names that can derive the empty string. */
export function computeNullable(g: Grammar): Set<string> {
  const nullable = new Set<string>();
  for (;;) {
    let changed = false;
    for (const [name, rule] of g.rules) {
      if (nullable.has(name)) continue;
      if (rule.alts.some((seq) => seqNullable(seq, nullable))) {
        nullable.add(name);
        changed = true;
      }
    }
    if (!changed) return nullable;
  }
}

function nodeProductive(
  node: GbnfNode,
  productive: Set<string>,
  g: Grammar
): boolean {
  switch (node.kind) {
    case "lit":
    case "any":
      return true;
    case "class":
      // A negated class always matches something; a plain class needs at
      // least one non-reversed range. `[]` and `[z-a]` match nothing.
      return node.negated || node.items.some((i) => i.lo <= i.hi);
    case "ref":
      // Undefined references are E002 already; treating them as productive
      // here keeps E008 from cascading off a typo.
      return g.rules.has(node.name) ? productive.has(node.name) : true;
    case "group":
      return node.alts.some((seq) =>
        seq.every((n) => nodeProductive(n, productive, g))
      );
    case "rep":
      return node.min === 0 || nodeProductive(node.item, productive, g);
  }
}

/**
 * Fixpoint: the set of rule names that can derive at least one finite
 * string. A rule outside this set (e.g. `a ::= "x" a` with no base case)
 * can start matching but never finish.
 */
export function computeProductive(g: Grammar): Set<string> {
  const productive = new Set<string>();
  for (;;) {
    let changed = false;
    for (const [name, rule] of g.rules) {
      if (productive.has(name)) continue;
      const ok = rule.alts.some((seq) =>
        seq.every((n) => nodeProductive(n, productive, g))
      );
      if (ok) {
        productive.add(name);
        changed = true;
      }
    }
    if (!changed) return productive;
  }
}

/** Rule names reachable from `start` through references. */
export function reachableRules(g: Grammar, start = "root"): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  if (g.rules.has(start)) {
    seen.add(start);
    queue.push(start);
  }
  while (queue.length > 0) {
    const rule = g.rules.get(queue.pop() as string);
    if (!rule) continue;
    for (const node of walkNodes(rule)) {
      if (node.kind === "ref" && g.rules.has(node.name) && !seen.has(node.name)) {
        seen.add(node.name);
        queue.push(node.name);
      }
    }
  }
  return seen;
}

/** Every reference to a rule that is never defined, in source order. */
export function undefinedRefs(g: Grammar): { name: string; pos: Pos }[] {
  const out: { name: string; pos: Pos }[] = [];
  for (const rule of g.defs) {
    for (const node of walkNodes(rule)) {
      if (node.kind === "ref" && !g.rules.has(node.name)) {
        out.push({ name: node.name, pos: node.pos });
      }
    }
  }
  return out;
}

/**
 * Detect left recursion: cycles in the "can appear leftmost" relation,
 * where an item counts as leftmost if everything before it in its sequence
 * is nullable. llama.cpp rejects such grammars at load time, so each cycle
 * is a hard error. Returns one name list per cycle, in rule order.
 */
export function leftRecursionCycles(g: Grammar): string[][] {
  const nullable = computeNullable(g);
  const edges = new Map<string, Set<string>>();
  for (const [name, rule] of g.rules) {
    const targets = new Set<string>();
    for (const seq of rule.alts) collectLeftRefs(seq, targets, nullable);
    edges.set(name, targets);
  }

  // Tarjan's strongly connected components, iterative for deep grammars.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const strongConnect = (start: string): void => {
    interface FrameState {
      node: string;
      iter: Iterator<string>;
    }
    const frames: FrameState[] = [];
    const open = (node: string): void => {
      index.set(node, counter);
      low.set(node, counter);
      counter++;
      stack.push(node);
      onStack.add(node);
      frames.push({ node, iter: (edges.get(node) ?? new Set()).values() });
    };
    open(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as FrameState;
      const next = frame.iter.next();
      if (!next.done) {
        const target = next.value;
        if (!edges.has(target)) continue; // undefined rule: no edge
        if (!index.has(target)) {
          open(target);
        } else if (onStack.has(target)) {
          low.set(
            frame.node,
            Math.min(low.get(frame.node) as number, index.get(target) as number)
          );
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1] as FrameState;
        low.set(
          parent.node,
          Math.min(low.get(parent.node) as number, low.get(frame.node) as number)
        );
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop() as string;
          onStack.delete(member);
          component.push(member);
          if (member === frame.node) break;
        }
        const selfLoop =
          component.length === 1 &&
          (edges.get(component[0] as string) ?? new Set()).has(
            component[0] as string
          );
        if (component.length > 1 || selfLoop) {
          component.sort(
            (a, b) => g.order.indexOf(a) - g.order.indexOf(b)
          );
          cycles.push(component);
        }
      }
    }
  };

  for (const name of g.order) {
    if (!index.has(name)) strongConnect(name);
  }
  // Report cycles in the order their first rule is defined.
  cycles.sort(
    (a, b) =>
      g.order.indexOf(a[0] as string) - g.order.indexOf(b[0] as string)
  );
  return cycles;
}

function collectLeftRefs(
  seq: GbnfNode[],
  out: Set<string>,
  nullable: Set<string>
): void {
  for (const node of seq) {
    collectLeftEdge(node, out, nullable);
    if (!nodeNullable(node, nullable)) break;
  }
}

function collectLeftEdge(
  node: GbnfNode,
  out: Set<string>,
  nullable: Set<string>
): void {
  switch (node.kind) {
    case "ref":
      out.add(node.name);
      break;
    case "group":
      for (const seq of node.alts) collectLeftRefs(seq, out, nullable);
      break;
    case "rep":
      // The machine may enter the repeated item before consuming anything,
      // regardless of `min` (min = 0 just also allows skipping it).
      collectLeftEdge(node.item, out, nullable);
      break;
    default:
      break; // literals, classes and `.` contribute no edges
  }
}
