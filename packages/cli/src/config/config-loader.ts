import fs from "fs-extra";
import path from "path";

export type CliConfig = Record<string, unknown>;

export const CURRENT_CONFIG_VERSION = 2;

export async function loadCliConfig(
  configPath?: string,
  cwd: string = process.cwd(),
): Promise<CliConfig> {
  const resolvedPath = path.resolve(cwd, configPath || "gasguard.config.json");
  if (!configPath && !(await fs.pathExists(resolvedPath))) {
    return {};
  }
  return loadConfigFile(resolvedPath, new Set<string>());
}

async function loadConfigFile(
  configPath: string,
  ancestors: Set<string>,
): Promise<CliConfig> {
  const resolvedPath = path.resolve(configPath);
  if (ancestors.has(resolvedPath)) {
    throw new Error(
      `Configuration inheritance cycle detected at ${resolvedPath}`,
    );
  }
  if (!(await fs.pathExists(resolvedPath))) {
    throw new Error(`Configuration file not found: ${resolvedPath}`);
  }

  let config: unknown;
  try {
    config = await fs.readJson(resolvedPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read configuration ${resolvedPath}: ${detail}`);
  }
  if (!isConfigObject(config)) {
    throw new Error(
      `Configuration must contain a JSON object: ${resolvedPath}`,
    );
  }

  const migratedConfig = migrateCliConfig(config, resolvedPath);

  const extended = migratedConfig.extends;
  if (extended === undefined) {
    return migratedConfig;
  }
  if (typeof extended !== "string" || extended.trim() === "") {
    throw new Error(
      `Configuration "extends" must be a non-empty path: ${resolvedPath}`,
    );
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(resolvedPath);
  const parentPath = path.resolve(path.dirname(resolvedPath), extended);
  const parentConfig = await loadConfigFile(parentPath, nextAncestors);
  const { extends: _extends, ...overrides } = migratedConfig;
  return mergeConfig(parentConfig, overrides);
}

export function migrateCliConfig(
  config: CliConfig,
  source = "configuration",
): CliConfig {
  const version = config.configVersion ?? 1;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new Error(
      `Invalid configVersion in ${source}: expected a positive integer.`,
    );
  }
  if (version > CURRENT_CONFIG_VERSION) {
    throw new Error(
      `Unsupported configVersion ${version} in ${source}; this CLI supports versions up to ${CURRENT_CONFIG_VERSION}.`,
    );
  }
  if (version === CURRENT_CONFIG_VERSION) return config;

  const migrated: CliConfig = { ...config };
  const scan = isConfigObject(migrated.scan) ? { ...migrated.scan } : {};
  const output = isConfigObject(migrated.output) ? { ...migrated.output } : {};
  if (scan.include === undefined && Array.isArray(migrated.includePatterns)) {
    scan.include = migrated.includePatterns;
  }
  if (scan.exclude === undefined && Array.isArray(migrated.excludePatterns)) {
    scan.exclude = migrated.excludePatterns;
  }
  if (
    output.format === undefined &&
    typeof migrated.outputFormat === "string"
  ) {
    output.format = migrated.outputFormat;
  }

  delete migrated.includePatterns;
  delete migrated.excludePatterns;
  delete migrated.outputFormat;
  if (Object.keys(scan).length > 0) migrated.scan = scan;
  if (Object.keys(output).length > 0) migrated.output = output;
  if (Object.prototype.hasOwnProperty.call(config, "configVersion")) {
    migrated.configVersion = CURRENT_CONFIG_VERSION;
  }
  return migrated;
}

export function mergeConfig(base: CliConfig, override: CliConfig): CliConfig {
  const merged: CliConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = Object.prototype.hasOwnProperty.call(merged, key)
      ? merged[key]
      : undefined;
    const mergedValue =
      isConfigObject(baseValue) && isConfigObject(value)
        ? mergeConfig(baseValue, value)
        : value;
    Object.defineProperty(merged, key, {
      value: mergedValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return merged;
}

function isConfigObject(value: unknown): value is CliConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
