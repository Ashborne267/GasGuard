import fs from "fs-extra";
import os from "os";
import path from "path";
import {
  CURRENT_CONFIG_VERSION,
  loadCliConfig,
  mergeConfig,
  migrateCliConfig,
} from "./config-loader";

describe("loadCliConfig", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "gasguard-cli-config-"),
    );
  });

  afterEach(async () => {
    await fs.remove(directory);
  });

  it("loads the default config path when it exists and returns empty when absent", async () => {
    expect(await loadCliConfig(undefined, directory)).toEqual({});
    await fs.writeJson(path.join(directory, "gasguard.config.json"), {
      scan: { maxFiles: 50 },
    });
    expect(await loadCliConfig(undefined, directory)).toEqual({
      scan: { maxFiles: 50 },
    });
  });

  it("resolves relative parents and deep-merges objects while replacing arrays", async () => {
    await fs.ensureDir(path.join(directory, "shared"));
    await fs.writeJson(path.join(directory, "shared/base.json"), {
      scan: {
        include: ["contracts/**/*.sol"],
        exclude: ["vendor/**"],
        maxFiles: 100,
      },
      rules: { severity: ["high"] },
    });
    await fs.writeJson(path.join(directory, "gasguard.config.json"), {
      extends: "shared/base.json",
      scan: { include: ["src/**/*.sol"] },
    });

    await expect(loadCliConfig(undefined, directory)).resolves.toEqual({
      scan: {
        include: ["src/**/*.sol"],
        exclude: ["vendor/**"],
        maxFiles: 100,
      },
      rules: { severity: ["high"] },
    });
  });

  it("supports inheritance chains", async () => {
    await fs.writeJson(path.join(directory, "base.json"), {
      output: { summary: true },
    });
    await fs.writeJson(path.join(directory, "middle.json"), {
      extends: "./base.json",
      output: { format: "text" },
    });
    await fs.writeJson(path.join(directory, "child.json"), {
      extends: "./middle.json",
      output: { summary: false },
    });

    await expect(loadCliConfig("child.json", directory)).resolves.toEqual({
      output: { summary: false, format: "text" },
    });
  });

  it("upgrades legacy keys while preserving current nested values", () => {
    expect(
      migrateCliConfig({
        configVersion: 1,
        includePatterns: ["legacy/**/*.sol"],
        excludePatterns: ["vendor/**"],
        outputFormat: "sarif",
        scan: { include: ["current/**/*.sol"] },
      }),
    ).toEqual({
      configVersion: CURRENT_CONFIG_VERSION,
      scan: { include: ["current/**/*.sol"], exclude: ["vendor/**"] },
      output: { format: "sarif" },
    });
  });

  it("upgrades inherited legacy config without modifying its source file", async () => {
    const legacyPath = path.join(directory, "legacy.json");
    await fs.writeJson(legacyPath, {
      includePatterns: ["contracts/**/*.sol"],
      outputFormat: "json",
    });
    await fs.writeJson(path.join(directory, "child.json"), {
      extends: "legacy.json",
      scan: { exclude: ["vendor/**"] },
    });

    await expect(loadCliConfig("child.json", directory)).resolves.toEqual({
      scan: {
        include: ["contracts/**/*.sol"],
        exclude: ["vendor/**"],
      },
      output: { format: "json" },
    });
    await expect(fs.readJson(legacyPath)).resolves.toHaveProperty(
      "includePatterns",
      ["contracts/**/*.sol"],
    );
  });

  it("rejects invalid and newer schema versions and leaves current configs unchanged", () => {
    const current = {
      configVersion: CURRENT_CONFIG_VERSION,
      scan: { maxFiles: 10 },
    };
    expect(migrateCliConfig(current)).toBe(current);
    expect(() => migrateCliConfig({ configVersion: 0 })).toThrow(
      "expected a positive integer",
    );
    expect(() => migrateCliConfig({ configVersion: "1" })).toThrow(
      "expected a positive integer",
    );
    expect(() =>
      migrateCliConfig({ configVersion: CURRENT_CONFIG_VERSION + 1 }),
    ).toThrow("supports versions up to");
  });

  it("rejects missing parents, invalid extends values, and inheritance cycles", async () => {
    await fs.writeJson(path.join(directory, "missing.json"), {
      extends: "absent.json",
    });
    await expect(loadCliConfig("missing.json", directory)).rejects.toThrow(
      "Configuration file not found",
    );

    await fs.writeJson(path.join(directory, "invalid.json"), {
      extends: ["base.json"],
    });
    await expect(loadCliConfig("invalid.json", directory)).rejects.toThrow(
      '"extends" must be a non-empty path',
    );

    await fs.writeJson(path.join(directory, "a.json"), { extends: "b.json" });
    await fs.writeJson(path.join(directory, "b.json"), { extends: "a.json" });
    await expect(loadCliConfig("a.json", directory)).rejects.toThrow(
      "inheritance cycle detected",
    );
  });

  it("rejects malformed and non-object configuration files", async () => {
    await fs.writeFile(path.join(directory, "malformed.json"), "{ invalid");
    await expect(loadCliConfig("malformed.json", directory)).rejects.toThrow(
      "Unable to read configuration",
    );

    await fs.writeJson(path.join(directory, "array.json"), []);
    await expect(loadCliConfig("array.json", directory)).rejects.toThrow(
      "Configuration must contain a JSON object",
    );
  });

  it("merges untrusted object keys without changing the config prototype", () => {
    const result = mergeConfig(
      {},
      JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
    );

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(
      true,
    );
  });
});
