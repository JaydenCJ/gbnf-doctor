/**
 * GBNF parser, faithful to the llama.cpp grammar loader:
 *
 * - rule names are `[a-zA-Z0-9-]+` (no underscore);
 * - a rule body may start on the line after `::=`, and newlines are
 *   allowed anywhere inside a parenthesized group, but a *top-level*
 *   sequence ends at the first newline;
 * - a trailing `|` continues the alternation onto the next line, while a
 *   leading `|` on a new line is an error (P008, with a fix-it hint);
 * - escapes are exactly llama.cpp's set: \x.. \u.... \U........ and
 *   \t \r \n \\ \" \[ \];
 * - repetition operators (`*` `+` `?` `{m,n}`) bind to the whole previous
 *   element — `"ab"*` repeats the two-character literal, not just `b`;
 * - repetitions may follow a space (`item *` equals `item*`), and stacked
 *   operators compose (`a*?` is `(a*)?`), both as in llama.cpp.
 *
 * Two deliberate deviations, both stricter than llama.cpp: a raw newline
 * inside a literal or character class is rejected (llama.cpp silently
 * swallows it, which is almost always a missing quote or bracket), and
 * duplicate rule definitions are preserved for the linter instead of being
 * silently overwritten (matching still uses the last definition, as
 * llama.cpp does).
 */

import type {
  ClassItem,
  GbnfNode,
  Grammar,
  ParseResult,
  Pos,
  Rule,
} from "./types.js";

/** Stable codes for parse-time failures, used in CLI output and docs. */
export const PARSE_CODES: Record<string, string> = {
  P001: "unexpected end of input",
  P002: 'expected "::=" after a rule name',
  P003: "unterminated string literal",
  P004: "unterminated character class",
  P005: "invalid escape sequence",
  P006: "invalid repetition",
  P007: "unexpected character",
  P008: 'a top-level line may not begin with "|"',
  P009: "invalid rule name",
};

/** Thrown for the first syntax error; carries a stable code and position. */
export class GbnfSyntaxError extends Error {
  readonly code: string;
  readonly line: number;
  readonly col: number;

  constructor(code: string, message: string, line: number, col: number) {
    super(message);
    this.name = "GbnfSyntaxError";
    this.code = code;
    this.line = line;
    this.col = col;
  }
}

function isWordChar(c: string): boolean {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    c === "-"
  );
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

class Parser {
  private readonly src: string;
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(src: string) {
    this.src = src;
  }

  parseGrammar(): Grammar {
    const defs: Rule[] = [];
    this.skipSpace(true);
    while (this.pos < this.src.length) {
      if (this.peek() === "|") {
        this.err(
          "P008",
          'a top-level line may not begin with "|" — llama.cpp does not ' +
            'support this continuation style; put the "|" at the end of the ' +
            "previous line or wrap the whole rule body in ( ... )"
        );
      }
      defs.push(this.parseRule());
      this.skipSpace(true);
    }
    const rules = new Map<string, Rule>();
    const order: string[] = [];
    for (const rule of defs) {
      if (!rules.has(rule.name)) order.push(rule.name);
      rules.set(rule.name, rule); // last definition wins, as in llama.cpp
    }
    return { defs, rules, order };
  }

  // --- rule level -------------------------------------------------------

  private parseRule(): Rule {
    const pos = this.mark();
    const name = this.parseName();
    this.skipSpace(false);
    if (this.peek() === "_") {
      this.err(
        "P009",
        `rule names may contain only letters, digits and "-" ` +
          `(found "_" after "${name}")`
      );
    }
    if (this.peek() !== ":" || this.at(1) !== ":" || this.at(2) !== "=") {
      if (this.pos >= this.src.length) {
        this.err("P001", `unexpected end of input after rule name "${name}"`);
      }
      this.err(
        "P002",
        `expected "::=" after rule name "${name}", found "${this.peek()}"`
      );
    }
    this.advance();
    this.advance();
    this.advance();
    this.skipSpace(true); // the body may start on the next line
    const alts = this.parseAlternates(false, name);
    const c = this.peek();
    if (c !== "" && c !== "\n" && c !== "\r") {
      if (c === ":" && this.at(1) === ":") {
        this.err(
          "P007",
          `unexpected "::=" inside the body of rule "${name}" — the name ` +
            "before it was parsed as a rule reference; this usually means a " +
            'trailing "|" or a missing newline on the previous line'
        );
      }
      if (c === ")") {
        this.err("P007", 'unexpected ")" — no group is open here');
      }
      this.err("P007", `unexpected character "${c}" in rule "${name}"`);
    }
    return { name, alts, pos };
  }

  private parseAlternates(nested: boolean, ruleName: string): GbnfNode[][] {
    const alts: GbnfNode[][] = [this.parseSequence(nested, ruleName)];
    while (this.peek() === "|") {
      this.advance();
      this.skipSpace(true); // a trailing "|" continues on the next line
      alts.push(this.parseSequence(nested, ruleName));
    }
    return alts;
  }

  private parseSequence(nested: boolean, ruleName: string): GbnfNode[] {
    const items: GbnfNode[] = [];
    for (;;) {
      const c = this.peek();
      const pos = this.mark();
      if (c === '"') {
        items.push(this.parseLiteral());
      } else if (c === "[") {
        items.push(this.parseClass());
      } else if (c === "(") {
        this.advance();
        this.skipSpace(true);
        const alts = this.parseAlternates(true, ruleName);
        if (this.peek() !== ")") {
          this.err(
            this.pos >= this.src.length ? "P001" : "P007",
            `expected ")" to close the group opened at line ${pos.line}, ` +
              `col ${pos.col}`
          );
        }
        this.advance();
        items.push({ kind: "group", alts, pos });
      } else if (c === ".") {
        this.advance();
        items.push({ kind: "any", pos });
      } else if (c !== "" && isWordChar(c)) {
        const name = this.parseName();
        if (this.peek() === "_") {
          this.err(
            "P009",
            `rule names may contain only letters, digits and "-" ` +
              `(found "_" after "${name}")`
          );
        }
        items.push({ kind: "ref", name, pos });
      } else if (c === "*") {
        this.advance();
        this.applyRep(items, 0, null);
      } else if (c === "+") {
        this.advance();
        this.applyRep(items, 1, null);
      } else if (c === "?") {
        this.advance();
        this.applyRep(items, 0, 1);
      } else if (c === "{") {
        const { min, max } = this.parseBounds();
        this.applyRep(items, min, max);
      } else {
        break;
      }
      this.skipSpace(nested);
    }
    return items;
  }

  private applyRep(items: GbnfNode[], min: number, max: number | null): void {
    const last = items.pop();
    if (last === undefined) {
      this.err(
        "P006",
        "repetition operator has nothing to repeat — it must follow a " +
          "literal, character class, rule reference, `.` or group"
      );
    }
    items.push({ kind: "rep", item: last, min, max, pos: last.pos });
  }

  private parseBounds(): { min: number; max: number | null } {
    this.advance(); // consume "{"
    this.skipSpace(false);
    const min = this.parseInt();
    this.skipSpace(false);
    const c = this.peek();
    if (c === "}") {
      this.advance();
      return { min, max: min };
    }
    if (c !== ",") {
      this.err(
        this.pos >= this.src.length ? "P001" : "P006",
        'expected "," or "}" in repetition bounds'
      );
    }
    this.advance();
    this.skipSpace(false);
    let max: number | null = null;
    if (isDigit(this.peek())) {
      max = this.parseInt();
      this.skipSpace(false);
    }
    if (this.peek() !== "}") {
      this.err(
        this.pos >= this.src.length ? "P001" : "P006",
        'expected "}" to close repetition bounds'
      );
    }
    this.advance();
    return { min, max };
  }

  private parseInt(): number {
    if (!isDigit(this.peek())) {
      this.err("P006", 'expected an integer in "{...}" repetition bounds');
    }
    let digits = "";
    while (isDigit(this.peek())) {
      digits += this.peek();
      this.advance();
    }
    if (digits.length > 9) {
      this.err("P006", `repetition bound "${digits}" is too large`);
    }
    return Number.parseInt(digits, 10);
  }

  // --- terminals --------------------------------------------------------

  private parseLiteral(): GbnfNode {
    const pos = this.mark();
    this.advance(); // consume opening quote
    let value = "";
    for (;;) {
      const c = this.peek();
      if (c === "") {
        this.err("P003", "unterminated string literal", pos);
      }
      if (c === "\n" || c === "\r") {
        this.err(
          "P003",
          "unterminated string literal — a raw line break is not allowed " +
            'inside "..."; use \\n to match a newline',
          pos
        );
      }
      if (c === '"') {
        this.advance();
        break;
      }
      if (c === "\\") {
        value += String.fromCodePoint(this.parseEscape());
      } else {
        value += String.fromCodePoint(this.readRawCodePoint());
      }
    }
    return { kind: "lit", value, pos };
  }

  private parseClass(): GbnfNode {
    const pos = this.mark();
    this.advance(); // consume "["
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.advance();
    }
    const items: ClassItem[] = [];
    for (;;) {
      const c = this.peek();
      if (c === "") {
        this.err("P004", "unterminated character class", pos);
      }
      if (c === "\n" || c === "\r") {
        this.err(
          "P004",
          "unterminated character class — a raw line break is not allowed " +
            "inside [ ]; use \\n to match a newline",
          pos
        );
      }
      if (c === "]") {
        this.advance();
        break;
      }
      const start = this.pos;
      const lo = c === "\\" ? this.parseEscape() : this.readRawCodePoint();
      let hi = lo;
      // A "-" forms a range unless it is the last member before "]",
      // exactly as in llama.cpp ("[a-]" is the two members "a" and "-").
      if (this.peek() === "-" && this.at(1) !== "]" && this.at(1) !== "") {
        this.advance();
        hi =
          this.peek() === "\\" ? this.parseEscape() : this.readRawCodePoint();
      }
      items.push({ lo, hi, text: this.src.slice(start, this.pos) });
    }
    return { kind: "class", negated, items, pos };
  }

  private parseEscape(): number {
    const pos = this.mark();
    this.advance(); // consume "\"
    const c = this.peek();
    switch (c) {
      case "x":
        return this.parseHexEscape(2, pos);
      case "u":
        return this.parseHexEscape(4, pos);
      case "U":
        return this.parseHexEscape(8, pos);
      case "t":
        this.advance();
        return 0x09;
      case "r":
        this.advance();
        return 0x0d;
      case "n":
        this.advance();
        return 0x0a;
      case "\\":
        this.advance();
        return 0x5c;
      case '"':
        this.advance();
        return 0x22;
      case "[":
        this.advance();
        return 0x5b;
      case "]":
        this.advance();
        return 0x5d;
      case "-":
        this.err(
          "P005",
          '"\\-" is not a valid escape in llama.cpp — put "-" first or last ' +
            'in the character class, or write "\\x2D"',
          pos
        );
        break;
      case "":
        this.err("P005", "incomplete escape sequence at end of input", pos);
        break;
      default:
        this.err(
          "P005",
          `unknown escape sequence "\\${c}" ` +
            '(valid: \\xHH \\uHHHH \\UHHHHHHHH \\t \\r \\n \\\\ \\" \\[ \\])',
          pos
        );
    }
    /* unreachable — err() always throws */
    return 0;
  }

  private parseHexEscape(digits: number, pos: Pos): number {
    const marker = this.peek(); // x, u or U
    this.advance();
    let hex = "";
    for (let i = 0; i < digits; i++) {
      const c = this.peek();
      if (!isHex(c)) {
        this.err(
          "P005",
          `expected exactly ${digits} hex digits after "\\${marker}"`,
          pos
        );
      }
      hex += c;
      this.advance();
    }
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff) {
      this.err("P005", `escape "\\${marker}${hex}" is beyond U+10FFFF`, pos);
    }
    return cp;
  }

  private parseName(): string {
    const start = this.pos;
    while (isWordChar(this.peek())) this.advance();
    if (this.pos === start) {
      if (this.pos >= this.src.length) {
        this.err("P001", "unexpected end of input, expected a rule name");
      }
      this.err("P007", `expected a rule name, found "${this.peek()}"`);
    }
    return this.src.slice(start, this.pos);
  }

  // --- low-level cursor -------------------------------------------------

  private skipSpace(newlineOk: boolean): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t") {
        this.advance();
      } else if (c === "#") {
        while (this.pos < this.src.length && this.peek() !== "\n" && this.peek() !== "\r") {
          this.advance();
        }
      } else if (newlineOk && (c === "\n" || c === "\r")) {
        this.advance();
      } else {
        break;
      }
    }
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private at(delta: number): string {
    return this.src[this.pos + delta] ?? "";
  }

  /** Advance one UTF-16 code unit (all grammar structure is ASCII). */
  private advance(): void {
    if (this.src[this.pos] === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    this.pos++;
  }

  /** Read one full code point (for literal/class content, may be astral). */
  private readRawCodePoint(): number {
    const cp = this.src.codePointAt(this.pos);
    /* c8 ignore next */
    if (cp === undefined) this.err("P001", "unexpected end of input");
    this.pos += cp > 0xffff ? 2 : 1;
    this.col++;
    return cp;
  }

  private mark(): Pos {
    return { offset: this.pos, line: this.line, col: this.col };
  }

  private err(code: string, message: string, pos?: Pos): never {
    const line = pos ? pos.line : this.line;
    const col = pos ? pos.col : this.col;
    throw new GbnfSyntaxError(code, message, line, col);
  }
}

/**
 * Parse GBNF text. Returns either a grammar or a single positioned parse
 * error as a diagnostic — never both, never neither.
 */
export function parseGbnf(src: string): ParseResult {
  try {
    return { grammar: new Parser(src).parseGrammar(), error: null };
  } catch (e) {
    if (e instanceof GbnfSyntaxError) {
      return {
        grammar: null,
        error: {
          code: e.code,
          severity: "error",
          message: e.message,
          line: e.line,
          col: e.col,
        },
      };
    }
    /* c8 ignore next */
    throw e;
  }
}
