import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCalibration,
  displayName,
  parseCalibration,
  readCalibrationFile,
  writeCalibrationFile,
  type CalibrationFile,
} from "../src/pricing.js";
import { MODELS } from "../src/catalog.js";

const sample = (): CalibrationFile => ({
  version: 1,
  catalogVersion: "0.1.2",
  calibratedAt: "2026-08-30T00:00:00.000Z",
  models: {
    "cline-pass/kimi-k3": {
      input: 9,
      output: 45,
      cacheRead: 0.9,
      calibratedAt: "2026-08-30T00:00:00.000Z",
    },
  },
});

describe("parseCalibration", () => {
  it("parses a valid file", () => {
    const f = parseCalibration(JSON.stringify(sample()));
    expect(f?.models["cline-pass/kimi-k3"]?.input).toBe(9);
    expect(f?.models["cline-pass/kimi-k3"]?.output).toBe(45);
  });

  it("rejects malformed content, wrong versions, and non-positive rates", () => {
    expect(parseCalibration("not json")).toBeUndefined();
    expect(parseCalibration(JSON.stringify({ version: 2, models: {} }))).toBeUndefined();
    expect(parseCalibration(JSON.stringify({ version: 1, models: { x: { input: -1, output: 2, cacheRead: 3, calibratedAt: "t" } } }))).toBeUndefined();
    expect(parseCalibration(JSON.stringify({ version: 1, models: {} }))).toBeUndefined();
  });

  it("skips bad entries but keeps good ones", () => {
    const text = JSON.stringify({
      version: 1,
      calibratedAt: "t",
      models: {
        good: { input: 1, output: 2, cacheRead: 0.5, calibratedAt: "t" },
        bad: { input: "x", output: 2, cacheRead: 0.5, calibratedAt: "t" },
      },
    });
    const f = parseCalibration(text);
    expect(f?.models["good"]).toBeDefined();
    expect(f?.models["bad"]).toBeUndefined();
  });
});

describe("applyCalibration", () => {
  it("overrides only calibrated models and forces cacheWrite 0", () => {
    const before = MODELS.find((m) => m.id === "cline-pass/kimi-k3")!;
    const other = MODELS.find((m) => m.id === "cline-pass/mimo-v2.5")!;
    const merged = applyCalibration(MODELS, sample());
    const kimi = merged.find((m) => m.id === "cline-pass/kimi-k3")!;
    expect(kimi.cost).toEqual({ input: 9, output: 45, cacheRead: 0.9, cacheWrite: 0 });
    // Untouched models keep both values and identity.
    const untouched = merged.find((m) => m.id === "cline-pass/mimo-v2.5")!;
    expect(untouched.cost).toEqual(other.cost);
    expect(untouched).toBe(other);
    expect(before.cost.input).not.toBe(9); // static catalog never mutated
  });
});

describe("displayName", () => {
  it("shows the effective price for paid models", () => {
    const kimi = MODELS.find((m) => m.id === "cline-pass/kimi-k3")!;
    expect(displayName(kimi)).toBe("Kimi K3 ($6/$30)");
  });

  it("reflects calibration overrides (same effective source as everything else)", () => {
    const kimi = applyCalibration(MODELS, sample()).find((m) => m.id === "cline-pass/kimi-k3")!;
    expect(displayName(kimi)).toBe("Kimi K3 ($9/$45)");
  });

  it("marks free models as (free)", () => {
    const free = MODELS.find((m) => m.id === "cline-free/longcat-2.0")!;
    expect(displayName(free)).toBe("LongCat 2.0 (free)");
  });

  it("formats small rates without trailing zeros", () => {
    const mimo = MODELS.find((m) => m.id === "cline-pass/mimo-v2.5-pro")!;
    expect(displayName(mimo)).toBe("MiMo-V2.5-Pro ($0.435/$0.87)");
  });
});

describe("calibration file round-trip", () => {
  const path = join(tmpdir(), `clinepass-test-${process.pid}-${Date.now()}.json`);

  it("writes and reads back", () => {
    writeCalibrationFile(sample(), path);
    const back = readCalibrationFile(path);
    expect(back?.models["cline-pass/kimi-k3"]?.output).toBe(45);

    rmSync(path, { force: true });
    expect(readCalibrationFile(path)).toBeUndefined(); // gone → static catalog
  });
});
