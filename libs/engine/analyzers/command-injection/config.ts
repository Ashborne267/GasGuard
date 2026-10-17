/**
 * Configuration surface for the Command Injection analyzer (CWE-78).
 *
 * Options are read from `AnalyzerConfig.options.commandInjection`.
 */

export const COMMAND_INJECTION_OPTIONS_KEY = "commandInjection";

export interface CommandInjectionOptions {
  /**
   * Sanitizer or escaper function names considered safe guards against command injection.
   * Merged with {@link DEFAULT_SAFE_COMMAND_SANITIZERS}.
   */
  safeSanitizers?: string[];
  /**
   * Extra command execution wrapper sinks as dotted or simple call names (e.g. `"shellHelper.run"`).
   */
  additionalSinks?: string[];
  /**
   * Extra request-controlled input sources (e.g. `"event.body.cmd"`).
   */
  additionalSources?: string[];
  /**
   * How many lines around an exec call are searched for validation/sanitization guards.
   */
  proximityLines?: number;
  /** Files larger than this (UTF-8 bytes) are skipped with an error entry. */
  maxFileBytes?: number;
}

export interface ResolvedCommandInjectionOptions {
  safeSanitizers: string[];
  additionalSinks: string[];
  additionalSources: string[];
  proximityLines: number;
  maxFileBytes: number;
}

export const DEFAULT_SAFE_COMMAND_SANITIZERS: readonly string[] = [
  "escapeShellArg",
  "escapeShellCmd",
  "shellQuote",
  "quote",
  "shlex.quote",
  "sanitizeCommand",
  "isSafeCommand",
  "validateCommand",
  "sanitizeArg",
];

export const DEFAULT_PROXIMITY_LINES = 10;
export const MAX_PROXIMITY_LINES = 100;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MB
export const MAX_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

export const SUPPORTED_COMMAND_EXTENSIONS: readonly string[] = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const DOTTED_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

export function validateCommandInjectionOptions(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return [`options.${COMMAND_INJECTION_OPTIONS_KEY} must be an object`];
  }

  const errors: string[] = [];
  const opts = raw as Record<string, unknown>;

  const checkList = (key: string, pattern: RegExp, expected: string) => {
    const value = opts[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push(`options.${COMMAND_INJECTION_OPTIONS_KEY}.${key} must be an array of strings`);
      return;
    }
    for (const item of value) {
      if (typeof item !== "string" || !pattern.test(item.trim())) {
        errors.push(
          `options.${COMMAND_INJECTION_OPTIONS_KEY}.${key} entry ${JSON.stringify(item)} must be ${expected}`,
        );
      }
    }
  };

  checkList("safeSanitizers", IDENTIFIER, "a valid identifier or dotted path");
  checkList("additionalSinks", DOTTED_PATH, "a call name");
  checkList("additionalSources", DOTTED_PATH, "a dotted member path");

  const checkInt = (key: string, min: number, max: number) => {
    const value = opts[key];
    if (value === undefined) return;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      errors.push(
        `options.${COMMAND_INJECTION_OPTIONS_KEY}.${key} must be an integer between ${min} and ${max}`,
      );
    }
  };

  checkInt("proximityLines", 1, MAX_PROXIMITY_LINES);
  checkInt("maxFileBytes", 1, MAX_MAX_FILE_BYTES);

  return errors;
}

export function resolveCommandInjectionOptions(
  raw: CommandInjectionOptions | undefined,
): ResolvedCommandInjectionOptions {
  const opts = raw ?? {};
  return {
    safeSanitizers: Array.from(
      new Set([...DEFAULT_SAFE_COMMAND_SANITIZERS, ...(opts.safeSanitizers ?? [])]),
    ),
    additionalSinks: [...(opts.additionalSinks ?? [])],
    additionalSources: [...(opts.additionalSources ?? [])],
    proximityLines: opts.proximityLines ?? DEFAULT_PROXIMITY_LINES,
    maxFileBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
}

export function fileExtension(filePath: string): string {
  const base = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export function isDeclarationFile(filePath: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/i.test(filePath);
}

export function isSupportedCommandFile(filePath: string): boolean {
  return (
    SUPPORTED_COMMAND_EXTENSIONS.includes(fileExtension(filePath)) &&
    !isDeclarationFile(filePath)
  );
}
