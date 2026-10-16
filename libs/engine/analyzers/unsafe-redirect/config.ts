/**
 * Configuration surface for the unsafe redirect analyzer.
 *
 * Options are read from `AnalyzerConfig.options.unsafeRedirect`. Every option
 * is optional; omitting the block entirely gives the documented defaults, so
 * existing analyzer configs keep working unchanged.
 */

export const UNSAFE_REDIRECT_OPTIONS_KEY = "unsafeRedirect";

export interface UnsafeRedirectOptions {
  /**
   * Extra validator function names. A redirect whose target is passed through
   * one of these (directly, or in a guard shortly before the redirect) is
   * treated as validated. Merged with {@link DEFAULT_SAFE_VALIDATORS}.
   */
  safeValidators?: string[];
  /**
   * Extra redirect sinks, as dotted call names (e.g. `"h.redirect"`). The
   * first argument of the call is treated as the redirect target.
   */
  additionalSinks?: string[];
  /**
   * Extra request-controlled sources, as dotted member paths (e.g.
   * `"event.multiValueQueryStringParameters"`).
   */
  additionalSources?: string[];
  /**
   * How many lines before a redirect are searched for a guard on the target,
   * and around a relative-path check for a protocol-relative (`//`) check.
   */
  proximityLines?: number;
  /** Files larger than this (UTF-8 bytes) are skipped with an error entry. */
  maxFileBytes?: number;
}

export interface ResolvedUnsafeRedirectOptions {
  safeValidators: string[];
  additionalSinks: string[];
  additionalSources: string[];
  proximityLines: number;
  maxFileBytes: number;
}

export const DEFAULT_SAFE_VALIDATORS: readonly string[] = [
  "isSafeRedirect",
  "isSafeRedirectUrl",
  "isSafeUrl",
  "isValidRedirect",
  "isAllowedRedirect",
  "isAllowedUrl",
  "isLocalUrl",
  "isRelativeUrl",
  "isSameOrigin",
  "validateRedirect",
  "validateRedirectUrl",
  "safeRedirect",
  "sanitizeRedirect",
  "getSafeRedirect",
  "ensureSafeRedirect",
];

export const DEFAULT_PROXIMITY_LINES = 25;
export const MAX_PROXIMITY_LINES = 500;
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;
export const MAX_MAX_FILE_BYTES = 50_000_000;

/** File extensions the analyzer understands. Anything else is skipped. */
export const SUPPORTED_REDIRECT_EXTENSIONS: readonly string[] = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const DOTTED_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Validate the raw options block. Returns human-readable errors. */
export function validateUnsafeRedirectOptions(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return [`options.${UNSAFE_REDIRECT_OPTIONS_KEY} must be an object`];
  }

  const errors: string[] = [];
  const opts = raw as Record<string, unknown>;
  const known = new Set([
    "safeValidators",
    "additionalSinks",
    "additionalSources",
    "proximityLines",
    "maxFileBytes",
  ]);
  for (const key of Object.keys(opts)) {
    if (!known.has(key)) {
      errors.push(`options.${UNSAFE_REDIRECT_OPTIONS_KEY}.${key} is not a recognised option`);
    }
  }

  const checkList = (key: string, pattern: RegExp, shape: string) => {
    const value = opts[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      errors.push(`options.${UNSAFE_REDIRECT_OPTIONS_KEY}.${key} must be an array of ${shape}`);
      return;
    }
    value.forEach((item, idx) => {
      if (typeof item !== "string" || !pattern.test(item)) {
        errors.push(
          `options.${UNSAFE_REDIRECT_OPTIONS_KEY}.${key}[${idx}] must be ${shape}`,
        );
      }
    });
  };
  checkList("safeValidators", IDENTIFIER, "an identifier");
  checkList("additionalSinks", DOTTED_PATH, "a dotted call name");
  checkList("additionalSources", DOTTED_PATH, "a dotted member path");

  const checkInt = (key: string, min: number, max: number) => {
    const value = opts[key];
    if (value === undefined) return;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      errors.push(
        `options.${UNSAFE_REDIRECT_OPTIONS_KEY}.${key} must be an integer between ${min} and ${max}`,
      );
    }
  };
  checkInt("proximityLines", 1, MAX_PROXIMITY_LINES);
  checkInt("maxFileBytes", 1, MAX_MAX_FILE_BYTES);

  return errors;
}

/** Apply defaults. Call only after {@link validateUnsafeRedirectOptions} passed. */
export function resolveUnsafeRedirectOptions(
  raw: UnsafeRedirectOptions | undefined,
): ResolvedUnsafeRedirectOptions {
  const opts = raw ?? {};
  return {
    safeValidators: Array.from(
      new Set([...DEFAULT_SAFE_VALIDATORS, ...(opts.safeValidators ?? [])]),
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

export function isSupportedRedirectFile(filePath: string): boolean {
  return (
    SUPPORTED_REDIRECT_EXTENSIONS.includes(fileExtension(filePath)) &&
    !isDeclarationFile(filePath)
  );
}
