/**
 * Canonical GBNF printer. Everything it emits re-parses to an identical
 * AST (round-trip enforced by tests), and only spellings that llama.cpp
 * accepts are produced — e.g. a literal "-" inside a character class is
 * written as \x2D because llama.cpp has no \- escape.
 */

import type { ClassItem, GbnfNode, Grammar, Rule } from "./types.js";

/** Quote a string as a GBNF literal, escaping exactly what llama.cpp reads. */
export function quoteLit(value: string): string {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += hexEscape(cp);
    else out += ch;
  }
  return out + '"';
}

function hexEscape(cp: number): string {
  if (cp <= 0xff) return "\\x" + cp.toString(16).padStart(2, "0");
  if (cp <= 0xffff) return "\\u" + cp.toString(16).padStart(4, "0");
  return "\\U" + cp.toString(16).padStart(8, "0");
}

function classChar(cp: number, first: boolean): string {
  if (cp === 0x5d) return "\\]"; // ]
  if (cp === 0x5c) return "\\\\";
  if (cp === 0x0a) return "\\n";
  if (cp === 0x0d) return "\\r";
  if (cp === 0x09) return "\\t";
  if (cp === 0x2d) return "\\x2D"; // "-": no \- escape exists in llama.cpp
  if (cp === 0x5e && first) return "\\x5E"; // "^" only special when first
  if (cp < 0x20 || cp === 0x7f) return hexEscape(cp);
  return String.fromCodePoint(cp);
}

function printClassItem(item: ClassItem, first: boolean): string {
  if (item.lo === item.hi) return classChar(item.lo, first);
  return classChar(item.lo, first) + "-" + classChar(item.hi, false);
}

function repSuffix(min: number, max: number | null): string {
  if (min === 0 && max === null) return "*";
  if (min === 1 && max === null) return "+";
  if (min === 0 && max === 1) return "?";
  if (max === null) return `{${min},}`;
  if (min === max) return `{${min}}`;
  return `{${min},${max}}`;
}

/** Print one node in canonical form. */
export function printNode(node: GbnfNode): string {
  switch (node.kind) {
    case "lit":
      return quoteLit(node.value);
    case "class": {
      let body = node.negated ? "^" : "";
      node.items.forEach((item, i) => {
        body += printClassItem(item, i === 0 && !node.negated);
      });
      return "[" + body + "]";
    }
    case "any":
      return ".";
    case "ref":
      return node.name;
    case "group":
      return "( " + node.alts.map(printSeq).join(" | ") + " )";
    case "rep":
      return printNode(node.item) + repSuffix(node.min, node.max);
  }
}

/** Print one alternative (a sequence). An empty sequence prints as "". */
export function printSeq(seq: GbnfNode[]): string {
  if (seq.length === 0) return '""';
  return seq.map(printNode).join(" ");
}

/** Print one rule definition. */
export function printRule(rule: Rule): string {
  return `${rule.name} ::= ${rule.alts.map(printSeq).join(" | ")}`;
}

/** Print a whole grammar (effective rules, in first-definition order). */
export function printGrammar(g: Grammar): string {
  const lines: string[] = [];
  for (const name of g.order) {
    lines.push(printRule(g.rules.get(name) as Rule));
  }
  return lines.join("\n") + "\n";
}
