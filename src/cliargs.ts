/**
 * Tiny argv parser for the CLI: long flags only, boolean or string-valued,
 * `--flag value` and `--flag=value` both accepted, `--` ends flag parsing.
 * Unknown flags are hard errors so typos never silently change behavior.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  [name: string]: "boolean" | "string";
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Parse argv against a flag spec. Throws {@link UsageError} on misuse. */
export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (flagsDone || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsDone = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[name];
    if (kind === undefined) {
      throw new UsageError(`unknown flag "--${name}"`);
    }
    if (kind === "boolean") {
      if (eq !== -1) {
        throw new UsageError(`flag "--${name}" does not take a value`);
      }
      flags[name] = true;
      continue;
    }
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new UsageError(`flag "--${name}" requires a value`);
    }
    flags[name] = value;
    i++;
  }
  return { positionals, flags };
}
