import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCalibrationFile,
  deriveRates,
  formatCalibrationReport,
  lowestEffort,
  runCalibration,
  type CalProgress,
  type CalibrationDeps,
  type CompleteArgs,
  type ProbeSet,
} from "../src/calibrate.js";
import { MODELS } from "../src/catalog.js";
import { resetUsageTrackingForTest, type UsageRecord } from "../src/usage.js";

const AUTH_JSON = "/home/test/.pi/agent/auth.json";
const norm = (p: string): string => p.replace(/\\/g, "/");
const future = (): number => Date.now() + 999_999;
const oauthFixture = (): string =>
  JSON.stringify({ clinepass: { type: "oauth", access: "workos:t", refresh: "rt", expires: future() } });

/** Injectable filesystem for token resolution (no network: valid future token). */
const usageOptions = {
  homeDir: () => "/home/test",
  readFile: (p: string) => {
    if (norm(p) !== AUTH_JSON) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return oauthFixture();
  },
  fileExists: (p: string) => norm(p) === AUTH_JSON,
};

let seq = 0;
const rec = (model: string, costMu: number, prompt: number, cached: number, completion: number, generationId?: string): UsageRecord => ({
  id: `usg-${seq++}`,
  generationId,
  model,
  promptTokens: prompt,
  cachedTokens: cached,
  completionTokens: completion,
  totalTokens: prompt + completion,
  costUsd: costMu / 1e8,
  createdAt: new Date().toISOString(),
});

/** Rates in micro-$ per token ($/1M = mu/100), e.g. kimi-k3 input 6.0 → 600 mu. */
interface FakeRates {
  inMu: number;
  outMu: number;
  crMu: number;
}

const makeDeps = (
  rates: Record<string, FakeRates>,
  opts: { failIds?: string[]; cacheMissIds?: string[] } = {},
) => {
  const pool: UsageRecord[] = [];
  const complete = vi.fn(async (args: CompleteArgs) => {
    if (opts.failIds?.includes(args.model.id)) throw new Error("provider 500");
    const r = rates[args.model.id]!;
    // Cache only engages on the warm big turn when the fake says so; the tiny
    // turn (T3) is only fired when the big turn engaged.
    const warm = args.maxTokens !== 32;
    const cached = warm && !(opts.cacheMissIds?.includes(args.model.id)) ? 4900 : 0;
    const prompt = 5000;
    const costMu = cached * r.crMu + (prompt - cached) * r.inMu + args.maxTokens * r.outMu;
    pool.push(rec(args.model.id, costMu, prompt, cached, args.maxTokens));
    return { stopReason: "stop" };
  });
  return {
    complete,
    fetchRecords: async () => [...pool],
    sleep: async () => {},
    usageOptions,
    concurrency: 2,
  } satisfies CalibrationDeps;
};

const model = (id: string) => MODELS.find((m) => m.id === id)!;

beforeEach(() => {
  resetUsageTrackingForTest();
});

// ─── deriveRates (pure algebra) ─────────────────────────────────────────────

/** kimi-k3 at catalog rates (in 600 mu/tok, out 3000, cr 60) — exact measures. */
const kimiSet = (): ProbeSet => ({
  aCold: { costMu: 3_096_000, prompt: 5000, cached: 0, completion: 32 },
  aWarmBig: { costMu: 3_354_000, prompt: 5000, cached: 4900, completion: 1000 },
  aWarmTiny: { costMu: 444_000, prompt: 5000, cached: 4900, completion: 30 },
});

describe("deriveRates — cache engaged (3 turns)", () => {
  it("recovers input/output/cacheRead from exact measures", () => {
    const d = deriveRates(kimiSet());
    expect(d.inputPerM).toBeCloseTo(6.0, 8);
    expect(d.outputPerM).toBeCloseTo(30.0, 8);
    expect(d.cacheReadPerM).toBeCloseTo(0.6, 8);
    expect(d.cacheEngaged).toBe(true);
    expect(d.needsWarmRefresh).toBe(false);
    expect(d.notes).toHaveLength(0);
  });

  it("survives micro-unit rounding noise (±2 units)", () => {
    const noisy = kimiSet();
    noisy.aCold.costMu += 2;
    noisy.aWarmBig.costMu -= 2;
    const tiny = noisy.aWarmTiny!;
    tiny.costMu += 1;
    const d = deriveRates(noisy);
    expect(d.inputPerM).toBeCloseTo(6.0, 5);
    expect(d.outputPerM).toBeCloseTo(30.0, 4);
    expect(d.cacheReadPerM).toBeCloseTo(0.6, 4);
  });

  it("flags prompt-identity divergence as retryable", () => {
    const ps = kimiSet();
    ps.aWarmBig.prompt = 5100;
    const d = deriveRates(ps);
    expect(d.needsWarmRefresh).toBe(true);
    expect(d.notes.some((f) => f.includes("diverged"))).toBe(true);
  });

  it("flags cached-token mismatch between warm turns as retryable", () => {
    const ps = kimiSet();
    const tiny = ps.aWarmTiny!;
    tiny.cached = 3000;
    const d = deriveRates(ps);
    expect(d.needsWarmRefresh).toBe(true);
    expect(d.notes.some((f) => f.includes("cached tokens differ"))).toBe(true);
  });

  it("flags output routes disagreeing is impossible here — but a tiny warm gap is retryable", () => {
    const ps = kimiSet();
    ps.aWarmBig.completion = 100; // gap vs tiny = 70 < 150
    ps.aWarmBig.costMu = 4900 * 60 + 100 * 600 + 100 * 3000;
    const d = deriveRates(ps);
    expect(d.needsWarmRefresh).toBe(true);
    expect(d.notes.some((f) => f.includes("warm output gap too small"))).toBe(true);
  });

  it("flags non-positive derived rates", () => {
    const ps = kimiSet();
    ps.aCold.costMu = 1; // nonsense: near-free cold turn
    const d = deriveRates(ps);
    expect(d.notes.some((n) => n.includes("not positive"))).toBe(true);
  });
});

describe("deriveRates — cache miss (2 turns, cold pair)", () => {
  it("derives input/output from the cold pair and inherits cacheRead", () => {
    const ps: ProbeSet = {
      aCold: { costMu: 3_096_000, prompt: 5000, cached: 0, completion: 32 },
      aWarmBig: { costMu: 6_000_000, prompt: 5000, cached: 0, completion: 1000 }, // fully cold, same prompt
      crRefMu: 60, // inherited cacheRead = $0.60/M
    };
    const d = deriveRates(ps);
    expect(d.inputPerM).toBeCloseTo(6.0, 8);
    expect(d.outputPerM).toBeCloseTo(30.0, 8);
    expect(d.cacheReadPerM).toBeUndefined();
    expect(d.cacheEngaged).toBe(false);
    expect(d.needsWarmRefresh).toBe(false);
    expect(d.notes.some((n) => n.includes("cache did not engage"))).toBe(true);
  });

  it("corrects a partially-cached miss with the inherited rate (exact recovery)", () => {
    // Gateway reports 128 cached tokens on the "miss" — subtract R·cr_ref and
    // the cold pair becomes exact again.
    const ps: ProbeSet = {
      aCold: { costMu: 3_096_000, prompt: 5000, cached: 0, completion: 32 },
      aWarmBig: { costMu: 5_930_880, prompt: 5000, cached: 128, completion: 1000 },
      crRefMu: 60,
    };
    const d = deriveRates(ps);
    expect(d.inputPerM).toBeCloseTo(6.0, 6);
    expect(d.outputPerM).toBeCloseTo(30.0, 6);
  });

  it("rejects a weakly conditioned cold pair", () => {
    const ps: ProbeSet = {
      aCold: { costMu: 3_096_000, prompt: 5000, cached: 0, completion: 32 },
      aWarmBig: { costMu: 3_096_000 + 1000 * 3000, prompt: 5000, cached: 0, completion: 32 + 1000 },
      crRefMu: 60,
    };
    // Same prompt + completion gap → det = P·(C2−C1) is fine here; force the
    // degenerate case by making outputs identical instead.
    ps.aWarmBig.completion = 32;
    ps.aWarmBig.costMu = 3_096_000;
    const d = deriveRates(ps);
    expect(d.inputPerM).toBe(0);
    expect(d.needsWarmRefresh).toBe(false);
    expect(d.notes[0]).toMatch(/conditioning/);
  });
});

// ─── effort ─────────────────────────────────────────────────────────────────

describe("lowestEffort", () => {
  it("picks the lowest effort each model actually supports", () => {
    expect(lowestEffort(model("cline-pass/kimi-k3"))).toBe("off"); // off → "none"
    expect(lowestEffort(model("cline-pass/kimi-k2.7-code"))).toBe("minimal"); // mandatory
    expect(lowestEffort(model("cline-pass/glm-5.3"))).toBe("low"); // mandatory, no minimal
  });
});

// ─── orchestration (injected probes + records) ─────────────────────────────

describe("runCalibration", () => {
  it("classifies unchanged vs repriced models and builds the file", async () => {
    const deps = makeDeps({
      "cline-pass/kimi-k3": { inMu: 600, outMu: 3000, crMu: 60 }, // == catalog → unchanged
      "cline-pass/mimo-v2.5": { inMu: 28, outMu: 56, crMu: 0.56 }, // 2x catalog → applied
    });
    const result = await runCalibration([model("cline-pass/kimi-k3"), model("cline-pass/mimo-v2.5")], deps);

    expect(result.applied).toBe(true);
    const kimi = result.results.find((r) => r.id === "cline-pass/kimi-k3")!;
    const mimo = result.results.find((r) => r.id === "cline-pass/mimo-v2.5")!;
    expect(kimi.status).toBe("unchanged");
    expect(kimi.after!.input).toBeCloseTo(6.0, 6);
    expect(kimi.cacheEngaged).toBe(true);
    expect(mimo.status).toBe("applied");
    expect(mimo.after!.input).toBeCloseTo(0.28, 6); // catalog 0.14 × 2
    expect(result.spentUsd).toBeGreaterThan(0);

    const file = buildCalibrationFile(result);
    expect(Object.keys(file.models).sort()).toEqual(["cline-pass/kimi-k3", "cline-pass/mimo-v2.5"]);
    expect(file.models["cline-pass/mimo-v2.5"]!.input).toBeCloseTo(0.28, 6);

    const report = formatCalibrationReport(result);
    expect(report).toContain("mimo-v2.5");
    expect(report).toContain("+100.0%");
    expect(report).toContain("Unchanged (1): kimi-k3");
  });

  it("labels a cancelled run as cancelled in the report", async () => {
    const deps = makeDeps({ "cline-pass/mimo-v2.5": { inMu: 28, outMu: 56, crMu: 0.56 } }); // 2x catalog → applied
    const result = await runCalibration([model("cline-pass/mimo-v2.5")], deps);
    const report = formatCalibrationReport(result, true);
    expect(report).toContain("cancelled");
    expect(report).not.toContain("complete");
    // Partial results are still listed — cancel stops the queue, not the file.
    expect(report).toContain("mimo-v2.5");
  });

  it("keeps previous prices for a hard-failing model", async () => {
    const deps = makeDeps(
      { "cline-pass/mimo-v2.5": { inMu: 14, outMu: 28, crMu: 0.28 } },
      { failIds: ["cline-pass/kimi-k3"] },
    );
    const result = await runCalibration([model("cline-pass/kimi-k3"), model("cline-pass/mimo-v2.5")], deps);
    const kimi = result.results.find((r) => r.id === "cline-pass/kimi-k3")!;
    expect(kimi.status).toBe("failed");
    expect(kimi.after).toBeUndefined();
    expect(kimi.notes[0]).toMatch(/probe failed/);
    // The underlying provider error is passed through, not swallowed.
    expect(kimi.notes[0]).toContain("provider 500");
    // The failed model must never reach the file.
    const file = buildCalibrationFile(result);
    expect(file.models["cline-pass/kimi-k3"]).toBeUndefined();
    expect(file.models["cline-pass/mimo-v2.5"]).toBeDefined();
  });

  it("correlates the probe's record by generationId despite concurrent same-model records", async () => {
    const rates: Record<string, FakeRates> = { "cline-pass/mimo-v2.5": { inMu: 14, outMu: 28, crMu: 0.28 } };
    const pool: UsageRecord[] = [];
    let gen = 0;
    const complete = vi.fn(async (args: CompleteArgs) => {
      const r = rates[args.model.id]!;
      const warm = args.maxTokens !== 32;
      const cached = warm ? 4900 : 0;
      const prompt = 5000;
      const costMu = cached * r.crMu + (prompt - cached) * r.inMu + args.maxTokens * r.outMu;
      const responseId = `gen-test-${++gen}`;
      pool.push(rec(args.model.id, costMu, prompt, cached, args.maxTokens, responseId));
      // Concurrent noise from another session: same model, fresh, newer —
      // would win the old heuristic and poison the bill.
      pool.push(rec(args.model.id, costMu + 999_999_999, 60_000, 59_000, args.maxTokens));
      return { stopReason: "stop", responseId };
    });
    const result = await runCalibration([model("cline-pass/mimo-v2.5")], {
      complete,
      fetchRecords: async () => [...pool],
      sleep: async () => {},
      usageOptions,
      concurrency: 1,
    });
    const mimo = result.results.find((r) => r.id === "cline-pass/mimo-v2.5")!;
    expect(mimo.after).toBeDefined();
    expect(mimo.after!.input).toBeCloseTo(0.14, 6); // catalog rate — not poisoned
    expect(mimo.after!.output).toBeCloseTo(0.28, 6);
  });

  it("inherits cacheRead and reports it when cache never engages (2 turns only)", async () => {
    const deps = makeDeps(
      { "cline-pass/kimi-k3": { inMu: 600, outMu: 3000, crMu: 60 } },
      { cacheMissIds: ["cline-pass/kimi-k3"] },
    );
    const result = await runCalibration([model("cline-pass/kimi-k3")], deps);
    const kimi = result.results[0]!;
    expect(kimi.status).toBe("unchanged"); // in/out derived exactly; cr inherited
    expect(kimi.cacheEngaged).toBe(false);
    expect(kimi.after!.cacheRead).toBeCloseTo(0.6, 8); // inherited catalog value
    // Cache miss → no tiny warm turn: exactly 2 probes.
    expect(deps.complete).toHaveBeenCalledTimes(2);
    const report = formatCalibrationReport(result);
    expect(report).toContain("Cache not measured (kimi-k3): cacheRead kept at $0.6000/M");
  });

  it("aborts the whole run on the global scale tripwire", async () => {
    const deps = makeDeps({
      "cline-pass/kimi-k3": { inMu: 60_000, outMu: 300_000, crMu: 6_000 }, // 100x catalog
    });
    const result = await runCalibration([model("cline-pass/kimi-k3")], deps);
    expect(result.applied).toBe(false);
    expect(result.anomaly).toMatch(/100\.00x/);
    const report = formatCalibrationReport(result);
    expect(report).toContain("aborted");
    expect(report).toContain("Prices remain unchanged");
  });

  it("emits live progress rows for the view", async () => {
    const events: CalProgress[] = [];
    const deps = {
      ...makeDeps({ "cline-pass/kimi-k3": { inMu: 600, outMu: 3000, crMu: 60 } }),
      onProgress: (p: CalProgress) => events.push(p),
    };
    const result = await runCalibration([model("cline-pass/kimi-k3")], deps);
    expect(result.results[0]!.status).toBe("unchanged");
    expect(result.applied).toBe(true); // tripwire fine; file write gated on `after` values
    expect(events.length).toBeGreaterThanOrEqual(3);
    const first = events[0]!;
    expect(first.rows[0]!.state).toBe("running");
    expect(first.total).toBe(1);
    const last = events[events.length - 1]!;
    expect(last.done).toBe(1);
    expect(last.rows[0]!.state).toBe("done");
    expect(last.rows[0]!.detail).toBe("unchanged");
    expect(last.spentUsd).toBeGreaterThan(0);
    // Turn labels surface while a model is in flight.
    expect(events.some((p) => p.rows[0]!.state === "running" && p.rows[0]!.detail === "T1")).toBe(true);
  });

  it("aborts the run immediately on a fatal error (dead login/quota)", async () => {
    const deps = {
      ...makeDeps({}),
      complete: vi.fn(async () => {
        throw new Error("401 Unauthorized");
      }),
      concurrency: 1,
    };
    const result = await runCalibration(
      [model("cline-pass/kimi-k3"), model("cline-pass/mimo-v2.5")],
      deps,
    );
    // Only the in-flight model burned retries; the rest were never attempted.
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe("failed");
    expect(result.results[0]!.notes[0]).toContain("401 Unauthorized");
    // No model has `after` values → the flow will never write this to the store.
  });

  it("stops after the same failure repeats on two different models", async () => {
    // An unclassifiable persistent failure: not in the fatal pattern list,
    // but two identical failures in a row mean a broken environment.
    const deps = {
      ...makeDeps({}),
      complete: vi.fn(async () => {
        throw new Error("gateway hiccup 999");
      }),
      concurrency: 1,
    };
    const result = await runCalibration(
      [model("cline-pass/kimi-k3"), model("cline-pass/mimo-v2.5"), model("cline-pass/minimax-m3")],
      deps,
    );
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.status === "failed")).toBe(true);
    expect(result.results[1]!.notes[0]).toContain("gateway hiccup 999");
  });

  it("returns nothing when cancelled before the run starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const deps = {
      ...makeDeps({ "cline-pass/kimi-k3": { inMu: 600, outMu: 3000, crMu: 60 } }),
      signal: controller.signal,
    };
    const result = await runCalibration([model("cline-pass/kimi-k3")], deps);
    expect(result.results).toHaveLength(0);
    expect(result.results.some((r) => r.after)).toBe(false);
    expect(deps.complete).not.toHaveBeenCalled();
  });
});
