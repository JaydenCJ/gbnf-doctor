/**
 * Minimal ambient declarations for the handful of Node.js built-ins this
 * project uses. Declaring them in-repo keeps `typescript` the only
 * devDependency (no `@types/node`); the surface below is intentionally
 * restricted to exactly what `src/` calls, so a typo against a real Node
 * API still fails to compile.
 */

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
}

declare var process: {
  argv: string[];
  cwd(): string;
  exitCode: number | undefined;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
  env: Record<string, string | undefined>;
};

declare var console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
