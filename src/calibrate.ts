/**
 * Price calibration: measure the real billing rates Cline's gateway charges
 * for each paid model, replacing the static catalog when it drifts.
 *
 * Probe design (adaptive 2→3 turns per model, single corpus, identical
 * requests fired through the exact same pi-ai path real chats use):
 *   T1 aCold    corpus A (~5k tok) maxTokens 32   — cold: seeds the cache and
 *                                                 provides the input-rate sample
 *   T2 aWarmBig corpus A            maxTokens 1000 — warm attempt, big output:
 *                                                 THE output-measurement turn
 *   T3 aWarmTiny corpus A            maxTokens 30   — warm tiny, fired only when
 *                                                 T2 engaged the cache
 *
 * Derivation (integer micro-units of $1e-8; $/1M = mu/100):
 *   T2 engaged (cachedTokens ≥ 1000): output = (K2−K3)/(C2−C3) — T2 and T3 are
 *     identical requests differing only in output length, so subtracting their
 *     bills cancels input and cache completely, leaving pure output cost.
 *     input = (K1 − C1·output)/P (the cold turn, corrected by the now-known
 *     output). cacheRead = (K3 − (P−R3)·input − C3·output)/R3.
 *   T2 missed (cachedTokens < 1000): T2 is a second full-price sample — input
 *     and output come from the cold pair (T1,T2); cacheRead is inherited from
 *     the current effective price (cache is the cheapest component; a stale
 *     cacheRead barely moves real cost, and its error is suppressed by the
 *     large solve determinant).
 *
 * Failure policy — never leave errors to the user: each turn retries once,
 * value-level anomalies re-run the warm pair once, anything still broken keeps
 * the model's previous prices with an explicit report line. A global
 * median-ratio tripwire (0.05x-20x) catches billing-unit changes. The corpus
 * is a deterministic fictional document (no PII, single prefix).
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ClinePassModel } from "./catalog.js";
import { PROVIDER_NAME, fetchUsageRecords, getActiveToken, modelsMatch, type UsageOptions, type UsageRecord } from "./usage.js";
import { DEFAULT_API_BASE } from "./workos.js";
import type { CalibratedRates, CalibrationFile } from "./pricing.js";

export type ProbeModel = ClinePassModel & {
  api: "openai-completions";
  provider: string;
  baseUrl: string;
};

// ─── Probe configuration ───────────────────────────────────────────────────

const PROBE_INSTRUCTION =
  "From the document above, summarize the most important figures, trends, and " +
  "open risks in one detailed paragraph. Use only figures that appear in the " +
  "document; do not invent numbers.";

const TURN_TIMEOUT_MS = 90_000;
/** Poll attempts for the server to flush the turn's usage record. */
const FLUSH_POLLS = 8;
const FLUSH_POLL_MS = 500;
const MIN_DET = 200_000;
/** cachedTokens at/above this on the warm turn = cache engaged. */
const MIN_CACHED = 1_000;
/** Minimum completion-token gap between the big and tiny warm turns. */
const MIN_WARM_DIFF = 150;
/** Rates within this fraction of the previous price count as "unchanged". */
const UNCHANGED_TOLERANCE = 0.005;

type TurnKey = "aCold" | "aWarmBig" | "aWarmTiny";

interface TurnSpec {
  key: TurnKey;
  maxTokens: number;
}

const TURN_A_COLD: TurnSpec = { key: "aCold", maxTokens: 32 };
const TURN_A_WARM_BIG: TurnSpec = { key: "aWarmBig", maxTokens: 1000 };
const TURN_A_WARM_TINY: TurnSpec = { key: "aWarmTiny", maxTokens: 30 };
/** View label per turn. */
const TURN_LABEL: Record<TurnKey, string> = { aCold: "T1", aWarmBig: "T2", aWarmTiny: "T3" };

// ─── Deterministic synthetic corpus (single prefix, no PII) ───────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(arr: readonly T[], r: () => number): T => arr[Math.floor(r() * arr.length)]!;
const num = (v: number): string => v.toLocaleString("en-US");
const moneyK = (r: () => number, lo: number, hi: number): string =>
  (lo + r() * (hi - lo)).toLocaleString("en-US", { maximumFractionDigits: 1 });

const PRODUCTS = ["Atlas", "Borealis", "Cinder", "Ember", "Gantry", "Helix", "Ionos", "Juniper", "Kestrel", "Lumen", "Onyx", "Pylon", "Quill", "Sable", "Tundra", "Vesper", "Wren", "Zephyr"] as const;
const REGIONS = ["us-east", "us-west", "eu-central", "eu-north", "ap-south", "ap-northeast", "sa-east"] as const;
const TEAMS = ["Platform", "Billing", "Growth", "Infrastructure", "Security", "Data", "Developer Experience", "Customer Reliability"] as const;
const CAUSES = ["a connection-pool leak", "a config drift in the edge tier", "an expired signing certificate", "a bad migration lock", "a retry storm from a partner integration"] as const;
const VENDORS = ["Northlake Logistics", "Copperfield Analytics", "Bluepeak Hosting", "Ravensworth Legal", "Stonewell Facilities", "Ironvale Supply"] as const;
const FEATURES = ["SSO enforcement", "audit exports", "usage-based invoicing", "regional data residency", "webhook replay", "granular RBAC"] as const;
const THEMES = ["invoice clarity", "API key rotation", "dashboard latency", "notification noise", "mobile parity"] as const;
const SPENDKIND = ["compute", "observability", "third-party licenses", "data transfer"] as const;

const BUILDERS: readonly ((r: () => number) => string)[] = [
  (r) => {
    const pct = int(r, 3, 34);
    return `- ${pick(PRODUCTS, r)}: ${num(int(r, 180, 2400))} support tickets resolved this week (${pct}% ${r() < 0.5 ? "better" : "worse"} than plan); median first response ${num(int(r, 8, 220))} minutes; queue depth ${(r() * 4 + 0.4).toFixed(1)}h at close, concentrated in ${pick(REGIONS, r)}.`;
  },
  (r) =>
    `- ${pick(PRODUCTS, r)} net revenue $${moneyK(r, 40, 980)}k (${int(r, 1, 28)}% ${r() < 0.6 ? "up" : "down"} QoQ); expansion revenue $${moneyK(r, 5, 90)}k; logo churn ${int(r, 0, 9)} accounts with gross retention at ${int(r, 86, 99)}%.`,
  (r) =>
    `- Incident review: ${int(r, 6, 240)}-minute degradation affecting ${num(int(r, 120, 90000))} sessions; root cause ${pick(CAUSES, r)}; mitigated by rollback plus a feature-flag freeze; follow-up owned by ${pick(TEAMS, r)} with a ${int(r, 2, 21)}-day fix window.`,
  (r) =>
    `- Policy change: expense reports above $${num(int(r, 200, 5000))} now require ${int(r, 2, 5)} approvals; reimbursement SLA ${int(r, 3, 15)} business days; receipts older than ${int(r, 30, 180)} days are auto-declined unless a manager override is attached.`,
  (r) =>
    `- Vendor: ${pick(VENDORS, r)} renewed at $${moneyK(r, 8, 400)}k/year (${int(r, -12, 18)}% vs prior term); contract includes a ${int(r, 30, 180)}-day termination notice and an uptime credit of ${int(r, 2, 15)}% per missed month.`,
  (r) =>
    `- Hiring: ${pick(TEAMS, r)} opened ${int(r, 1, 7)} ${pick(["senior", "staff", "mid-level"], r)} roles; pipeline shows ${num(int(r, 12, 240))} applicants, ${int(r, 3, 40)} screening calls, ${int(r, 1, 9)} onsite loops; target start within ${int(r, 3, 12)} weeks.`,
  (r) =>
    `- Roadmap: ${pick(PRODUCTS, r)} ships ${pick(FEATURES, r)} in ${pick(["Q1", "Q2", "Q3", "Q4"], r)}; engineering estimate ${int(r, 2, 26)} engineer-weeks behind a ${pick(["beta", "GA", "dark-launch"], r)} flag; dependencies limited to internal tooling.`,
  (r) =>
    `- Voice of customer: ${num(int(r, 20, 900))} survey responses; top theme (${int(r, 18, 55)}%) is ${pick(THEMES, r)}; NPS ${int(r, 21, 72)} with detractors concentrated in accounts older than ${int(r, 1, 5)} years.`,
  (r) =>
    `- Cost review: ${pick(SPENDKIND, r)} spend $${moneyK(r, 12, 320)}k MTD, forecast $${moneyK(r, 40, 900)}k EOM; ${int(r, 5, 40)}% of the spend tied to ${pick(["dev clusters", "log ingestion", "egress", "idle replicas"], r)} is flagged for rightsizing.`,
  (r) =>
    `- Compliance: SOC 2 evidence collection ${int(r, 20, 99)}% complete with ${int(r, 0, 12)} open findings (${int(r, 0, 4)} high); access reviews for ${pick(TEAMS, r)} due in ${int(r, 2, 30)} days; audit log retention verified for the trailing ${int(r, 6, 24)} months.`,
];

let corpusCache: string | undefined;

function probeCorpus(): string {
  corpusCache ??= (() => {
    const r = mulberry32(0xa1101);
    const parts: string[] = [
      "HELIOS DYNAMICS — OPERATIONS WIKI (INTERNAL)",
      "Helios Dynamics builds developer tooling for mid-market engineering teams. This wiki is the single source of truth for weekly operations, product performance, vendor commitments, and policy changes. Figures are point-in-time snapshots captured by the operations analytics pipeline; percentages compare against the trailing four-week baseline unless stated otherwise. Conflicts between this document and the dashboards should be treated as a stale-cache signal and reported through a data ticket.",
    ];
    let week = 1;
    // ~6,000 chars of this number-dense content measures ≈5,000 tokens on the
    // gateway (verified: dense figures tokenize at ~0.83 tokens/char).
    while (parts.join("\n\n").length < 6_000) {
      const lines: string[] = [`## Weekly operations digest — week ${week}`];
      const count = int(r, 5, 8);
      for (let i = 0; i < count; i++) lines.push(pick(BUILDERS, r)(r));
      parts.push(lines.join("\n"));
      week++;
    }
    return parts.join("\n\n");
  })();
  return corpusCache;
}

// ─── Rate derivation (pure) ────────────────────────────────────────────────

/** One probe turn's server-truth measurement; costMu is integer micro-$ (1e-8). */
export interface TurnMeasure {
  costMu: number;
  prompt: number;
  cached: number;
  completion: number;
}

export interface ProbeSet {
  aCold: TurnMeasure;
  aWarmBig: TurnMeasure;
  /** Present only when the warm turn engaged the cache. */
  aWarmTiny?: TurnMeasure;
  /** Inherited cacheRead in micro-$ per token (previous effective price) —
   * used to correct a partially-cached miss so in/out stay clean. */
  crRefMu?: number;
}

export interface DerivedRates {
  /** $/1M tokens. */
  inputPerM: number;
  outputPerM: number;
  /** undefined → cache never engaged; inherit previous cacheRead. */
  cacheReadPerM?: number;
  cacheEngaged: boolean;
  /** Value-level anomaly that one warm-pair refresh may fix. */
  needsWarmRefresh: boolean;
  notes: string[];
}

export function toMeasure(rec: UsageRecord): TurnMeasure {
  return {
    costMu: Math.round(rec.costUsd * 1e8),
    prompt: rec.promptTokens,
    cached: rec.cachedTokens,
    completion: rec.completionTokens,
  };
}

export function deriveRates(ps: ProbeSet): DerivedRates {
  const notes: string[] = [];
  let needsWarmRefresh = false;
  const markRefresh = (): void => {
    needsWarmRefresh = true;
  };
  const engaged = ps.aWarmBig.cached >= MIN_CACHED;

  // ── Cache miss: T2 is a second full-price sample → cold pair solve ──────
  if (!engaged) {
    const u2 = ps.aWarmBig.prompt - ps.aWarmBig.cached;
    const crRefMu = ps.crRefMu ?? 0;
    // Correct T2's bill for the (small) cached portion using the inherited rate.
    const k2 = ps.aWarmBig.costMu - ps.aWarmBig.cached * crRefMu;
    const det = ps.aCold.prompt * ps.aWarmBig.completion - u2 * ps.aCold.completion;
    if (!Number.isFinite(det) || Math.abs(det) < MIN_DET) {
      return {
        inputPerM: 0,
        outputPerM: 0,
        cacheEngaged: false,
        needsWarmRefresh: false,
        notes: [`cold-pair conditioning too weak (completion gap ${ps.aWarmBig.completion - ps.aCold.completion} tokens)`],
      };
    }
    const inMu = (ps.aCold.costMu * ps.aWarmBig.completion - k2 * ps.aCold.completion) / det;
    const outMu = (ps.aCold.prompt * k2 - u2 * ps.aCold.costMu) / det;
    if (!(inMu > 0) || !(outMu > 0)) {
      return {
        inputPerM: 0,
        outputPerM: 0,
        cacheEngaged: false,
        needsWarmRefresh: false,
        notes: ["derived input or output rate is not positive (billing anomaly)"],
      };
    }
    notes.push(`cache did not engage (cachedTokens ${ps.aWarmBig.cached})`);
    return {
      inputPerM: inMu / 100,
      outputPerM: outMu / 100,
      cacheEngaged: false,
      needsWarmRefresh: false,
      notes,
    };
  }

  // ── Cache engaged: output from the warm pair (T2 big vs T3 tiny) ────────
  if (!ps.aWarmTiny) {
    return {
      inputPerM: 0,
      outputPerM: 0,
      cacheEngaged: true,
      needsWarmRefresh: true,
      notes: ["cache engaged but the tiny warm turn is missing"],
    };
  }

  // Output: identical requests differing only in completion length —
  // subtracting the bills cancels input and cache entirely.
  const dC = ps.aWarmBig.completion - ps.aWarmTiny.completion;
  if (Math.abs(dC) < MIN_WARM_DIFF) {
    return {
      inputPerM: 0,
      outputPerM: 0,
      cacheEngaged: true,
      needsWarmRefresh: true,
      notes: [`warm output gap too small for derivation (${dC} tokens)`],
    };
  }
  const outMu = (ps.aWarmBig.costMu - ps.aWarmTiny.costMu) / dC;
  if (!(outMu > 0)) {
    return {
      inputPerM: 0,
      outputPerM: 0,
      cacheEngaged: true,
      needsWarmRefresh: true,
      notes: ["derived output rate is not positive (billing anomaly)"],
    };
  }

  // Identity: the warm pair must be the same request as each other (the
  // gateway may report cold vs warm prompt tokens differently — that is its
  // normal behavior; T1 needs no cross-check, its own P is used directly).
  if (Math.abs(ps.aWarmBig.prompt - ps.aWarmTiny.prompt) > Math.max(20, ps.aWarmTiny.prompt * 0.01)) {
    notes.push(`warm pair prompts diverged (${ps.aWarmBig.prompt} vs ${ps.aWarmTiny.prompt})`);
    markRefresh();
  }

  // Identity: identical requests → the gateway reports the same cached amount.
  if (Math.abs(ps.aWarmBig.cached - ps.aWarmTiny.cached) > Math.max(128, ps.aWarmTiny.cached * 0.02)) {
    notes.push(`cached tokens differ between warm turns (${ps.aWarmBig.cached} vs ${ps.aWarmTiny.cached})`);
    markRefresh();
  }

  // input from the cold turn — its output fragment is now a KNOWN quantity.
  const inMu = (ps.aCold.costMu - ps.aCold.completion * outMu) / ps.aCold.prompt;
  if (!(inMu > 0)) {
    return {
      inputPerM: 0,
      outputPerM: 0,
      cacheEngaged: true,
      needsWarmRefresh: false,
      notes: ["derived input rate is not positive (billing anomaly)"],
    };
  }

  // cacheRead from the tiny warm turn (smallest cancellation error).
  const crMu =
    (ps.aWarmTiny.costMu - (ps.aWarmTiny.prompt - ps.aWarmTiny.cached) * inMu - ps.aWarmTiny.completion * outMu) /
    ps.aWarmTiny.cached;
  if (!(crMu > 0)) {
    notes.push("derived cacheRead rate is not positive");
    markRefresh();
  }

  return {
    inputPerM: inMu / 100,
    outputPerM: outMu / 100,
    cacheReadPerM: crMu > 0 ? crMu / 100 : undefined,
    cacheEngaged: true,
    needsWarmRefresh,
    notes,
  };
}

// ─── Orchestration ─────────────────────────────────────────────────────────

const EFFORT_ORDER = ["off", "minimal", "low"] as const;
type LowEffort = (typeof EFFORT_ORDER)[number];

/** Lowest thinking effort the model supports (mandatory models cannot go off). */
export function lowestEffort(model: ClinePassModel): LowEffort {
  for (const level of EFFORT_ORDER) {
    if (typeof model.thinkingLevelMap[level] === "string") return level;
  }
  return "off";
}

export interface CompleteArgs {
  model: ProbeModel;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
  effort: LowEffort;
  apiKey: string;
  signal: AbortSignal;
}

type CompleteResult = { stopReason?: string; errorMessage?: string; responseId?: string };

export interface CalibrationDeps {
  complete?: (args: CompleteArgs) => Promise<CompleteResult>;
  /** Newest-first usage records for this account. */
  fetchRecords?: () => Promise<UsageRecord[] | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  concurrency?: number;
  usageOptions?: UsageOptions;
  onProgress?: (progress: CalProgress) => void;
}

const defaultComplete = async (args: CompleteArgs): Promise<CompleteResult> => {
  const msg = await completeSimple(
    args.model as Model<"openai-completions">,
    {
      systemPrompt: args.systemPrompt,
      messages: [{ role: "user", content: args.userMessage, timestamp: Date.now() }],
    },
    {
      apiKey: args.apiKey,
      maxTokens: args.maxTokens,
      // pi's ThinkingLevel has no "off": undefined lets thinkingLevelMap.off ("none") apply.
      reasoning: args.effort === "off" ? undefined : args.effort,
      signal: args.signal,
    },
  );
  // responseId is the stream chunk id — the exact /usages generationId.
  return { stopReason: msg.stopReason, errorMessage: msg.errorMessage, responseId: msg.responseId };
};

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
}

export interface CalibrationModelResult {
  id: string;
  status: "applied" | "unchanged" | "failed";
  before?: Rates;
  after?: Rates;
  /** Failure reason; empty for successful models. */
  notes: string[];
  spentUsd: number;
  cacheEngaged?: boolean;
}

export interface CalibrationRunResult {
  results: CalibrationModelResult[];
  spentUsd: number;
  applied: boolean;
  anomaly?: string;
}

/** Live per-model state for the calibration view. */
export interface CalRow {
  id: string;
  name: string;
  state: "queued" | "running" | "done" | "failed";
  /** T1/T2/T3 while running; repriced %/unchanged/failure reason when finished. */
  detail?: string;
}

export interface CalProgress {
  done: number;
  total: number;
  spentUsd: number;
  rows: readonly CalRow[];
}

/** Errors that mean every further probe would fail too (dead login,
 * exhausted quota) — the whole run must stop instead of burning retries per
 * model. The same-error-twice rule below catches whatever wording we did not
 * anticipate: if two different models fail identically, the environment is
 * broken, not the model. */
export class CalibrationFatalError extends Error {}

const FATAL_ERROR_PATTERN = /401|402|403|429|quota|credit|insufficient|usage limit|limit exceeded/i;
export function isFatalErrorMessage(message: string): boolean {
  return FATAL_ERROR_PATTERN.test(message);
}

function createdAtMs(rec: UsageRecord): number {
  const ms = Date.parse(rec.createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Run one probe turn; retries the whole cycle (request + record wait) once.
 * Returns the turn's billing record, or the failure reason as a string. */
async function runTurn(
  model: ProbeModel,
  turn: TurnSpec,
  apiKey: string,
  usedIds: Set<string>,
  deps: Required<Pick<CalibrationDeps, "complete" | "fetchRecords" | "sleep" | "now">>,
  signal: AbortSignal | undefined,
): Promise<UsageRecord | string> {
  let lastError = "no billing record";
  for (let cycle = 0; cycle < 2; cycle++) {
    if (signal?.aborted) return "cancelled";
    const turnStart = deps.now();
    let responseId: string | undefined;
    try {
      const msg = await deps.complete({
        model,
        systemPrompt: probeCorpus(),
        userMessage: PROBE_INSTRUCTION,
        maxTokens: turn.maxTokens,
        effort: lowestEffort(model),
        apiKey,
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      });
      if (msg.stopReason === "error") throw new Error(msg.errorMessage ?? "provider error");
      responseId = msg.responseId;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await deps.sleep(1500);
      continue;
    }
    // Wait for the server to flush this turn's billing record.
    for (let i = 0; i < FLUSH_POLLS; i++) {
      await deps.sleep(FLUSH_POLL_MS);
      if (signal?.aborted) return "cancelled";
      const records = (await deps.fetchRecords()) ?? [];
      // Exact correlation: the stream chunk id is the /usages generationId
      // (verified against the live API). Immune to concurrent same-model
      // activity from other sessions.
      const match = responseId
        ? records.find((rec) => rec.generationId === responseId)
        : undefined;
      if (match) return match;
      // Fallback heuristic when the stream id never arrived.
      const guess = records.find(
        (rec) =>
          rec.completionTokens > 0 &&
          modelsMatch(rec.model, model.id) &&
          !usedIds.has(rec.id) &&
          createdAtMs(rec) >= turnStart - 2000,
      );
      if (guess) return guess;
    }
  }
  return lastError;
}

async function calibrateModel(
  model: ClinePassModel,
  apiKey: string,
  deps: Required<Pick<CalibrationDeps, "complete" | "fetchRecords" | "sleep" | "now">>,
  signal: AbortSignal | undefined,
  onTurn?: (label: string) => void,
): Promise<CalibrationModelResult> {
  const probe: ProbeModel = {
    ...model,
    input: [...model.input],
    api: "openai-completions",
    provider: PROVIDER_NAME,
    baseUrl: `${DEFAULT_API_BASE}/api/v1`,
  };
  const usedIds = new Set<string>();
  const records = new Map<TurnKey, UsageRecord>();
  let spent = 0;
  const before: Rates = { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead };
  const fail = (note: string): CalibrationModelResult =>
    ({ id: model.id, status: "failed", before, notes: [note], spentUsd: spent });
  // A fatal error (dead login / exhausted quota) must stop the whole run.
  const gate = (err: string): string => {
    if (isFatalErrorMessage(err)) throw new CalibrationFatalError(err);
    return err;
  };

  const runSpec = async (spec: TurnSpec): Promise<string | undefined> => {
    onTurn?.(TURN_LABEL[spec.key]);
    const rec = await runTurn(probe, spec, apiKey, usedIds, deps, signal);
    if (typeof rec === "string") return rec;
    usedIds.add(rec.id);
    records.set(spec.key, rec);
    spent += rec.costUsd;
    return undefined;
  };

  // T1 always (cold sample + cache seed). T2 always (the output turn).
  let err = await runSpec(TURN_A_COLD);
  if (err) return fail(`aCold probe failed: ${gate(err)}`);
  err = await runSpec(TURN_A_WARM_BIG);
  if (err) return fail(`aWarmBig probe failed: ${gate(err)}`);

  const crRefMu = before.cacheRead * 100; // $/1M → micro-$ per token
  let derived = deriveRates({
    aCold: toMeasure(records.get("aCold")!),
    aWarmBig: toMeasure(records.get("aWarmBig")!),
    crRefMu,
  });

  // Cache engaged → one more warm turn (tiny) splits output from cacheRead.
  if (derived.cacheEngaged) {
    err = await runSpec(TURN_A_WARM_TINY);
    if (err) return fail(`aWarmTiny probe failed: ${gate(err)}`);
    derived = deriveRates({
      aCold: toMeasure(records.get("aCold")!),
      aWarmBig: toMeasure(records.get("aWarmBig")!),
      aWarmTiny: toMeasure(records.get("aWarmTiny")!),
      crRefMu,
    });
    if (derived.needsWarmRefresh) {
      // One warm-pair refresh for value-level anomalies.
      for (const spec of [TURN_A_WARM_BIG, TURN_A_WARM_TINY]) {
        err = await runSpec(spec);
        if (err) return fail(`${spec.key} refresh failed: ${gate(err)}`);
      }
      derived = deriveRates({
        aCold: toMeasure(records.get("aCold")!),
        aWarmBig: toMeasure(records.get("aWarmBig")!),
        aWarmTiny: toMeasure(records.get("aWarmTiny")!),
        crRefMu,
      });
      if (derived.needsWarmRefresh) {
        return {
          id: model.id,
          status: "failed",
          before,
          notes: derived.notes,
          spentUsd: spent,
        };
      }
    }
  }

  const cacheRead = derived.cacheReadPerM !== undefined ? derived.cacheReadPerM : before.cacheRead;
  const after: Rates = { input: derived.inputPerM, output: derived.outputPerM, cacheRead };
  const changed = (["input", "output", "cacheRead"] as const).some(
    (k) => Math.abs(after[k] - before[k]) > Math.max(before[k] * UNCHANGED_TOLERANCE, 1e-9),
  );
  return {
    id: model.id,
    status: changed ? "applied" : "unchanged",
    before,
    after,
    notes: [],
    spentUsd: spent,
    cacheEngaged: derived.cacheEngaged,
  };
}

/**
 * Calibrate the given paid models. Concurrent across models (bounded pool),
 * strictly sequential within a model. Never throws for a single model's
 * failure — failures degrade to "kept previous prices" results.
 */
export async function runCalibration(
  models: readonly ClinePassModel[],
  deps: CalibrationDeps = {},
): Promise<CalibrationRunResult> {
  const apiKey = await getActiveToken(deps.usageOptions ?? {});
  if (!apiKey) throw new Error("ClinePass calibration requires login (pi /login).");

  const bound = {
    complete: deps.complete ?? defaultComplete,
    fetchRecords: deps.fetchRecords ?? (() => fetchUsageRecords(deps.usageOptions ?? {}, 10)),
    sleep: deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
  };
  const signal = deps.signal;
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? 3, models.length));
  const results: CalibrationModelResult[] = [];
  const total = models.length;
  let done = 0;
  let next = 0;

  const rows: CalRow[] = models.map((m) => ({ id: m.id, name: m.name, state: "queued" as const }));
  let spentRunning = 0;
  const emit = (): void => {
    deps.onProgress?.({ done, total, spentUsd: spentRunning, rows: rows.map((r) => ({ ...r })) });
  };
  let fatal: string | undefined;
  let lastFailMsg: string | undefined;

  const worker = async (): Promise<void> => {
    while (next < models.length) {
      if (signal?.aborted || fatal !== undefined) return;
      const model = models[next++]!;
      const row = rows.find((r) => r.id === model.id)!;
      row.state = "running";
      emit();
      let result: CalibrationModelResult;
      try {
        result = await calibrateModel(model, apiKey, bound, signal, (label) => {
          row.detail = label;
          emit();
        });
      } catch (err) {
        result = {
          id: model.id,
          status: "failed",
          before: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead },
          notes: [err instanceof Error ? err.message : String(err)],
          spentUsd: 0,
        };
        if (err instanceof CalibrationFatalError) fatal = err.message;
      }
      results.push(result);
      done++;
      spentRunning += result.spentUsd;
      if (result.status === "failed") {
        row.state = "failed";
        row.detail = result.notes[0];
        // Two different models failing identically = broken environment:
        // stop the run instead of replaying the failure down the queue.
        const msg = result.notes[0] ?? "";
        if (msg && msg === lastFailMsg) fatal = msg;
        lastFailMsg = msg;
      } else {
        row.state = "done";
        lastFailMsg = undefined;
        if (result.status === "applied" && result.before && result.after) {
          const pct = Math.round((result.after.input / result.before.input - 1) * 100);
          row.detail = `repriced ${pct >= 0 ? "+" : ""}${pct}%`;
        } else {
          row.detail = "unchanged";
        }
      }
      emit();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  results.sort((a, b) => a.id.localeCompare(b.id));
  const spentUsd = results.reduce((sum, r) => sum + r.spentUsd, 0);

  // Global scale tripwire: internal checks are blind to a uniform unit change
  // (everything stays self-consistent), the median across models is not.
  const ratios = results
    .filter((r) => r.after && r.before && r.before.input > 0)
    .map((r) => r.after!.input / r.before!.input)
    .sort((a, b) => a - b);
  const median = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)]! : 1;
  const applied = median >= 0.05 && median <= 20;

  return {
    results,
    spentUsd,
    applied,
    anomaly: applied ? undefined : `derived prices are ${median.toFixed(2)}x the current ones on median — possible billing-unit change; nothing applied`,
  };
}

// ─── Report + persistence ─────────────────────────────────────────────────

const shortName = (id: string): string => id.replace("cline-pass/", "").replace(/-code$/, "");

function pctChange(before: number, after: number): string {
  if (before <= 0) return "?";
  const delta = ((after - before) / before) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

function deltaLine(r: CalibrationModelResult): string {
  const parts: string[] = [];
  for (const [label, key, decimals] of [
    ["input", "input", 2],
    ["output", "output", 2],
    ["cache", "cacheRead", 4],
  ] as const) {
    const b = r.before![key];
    const a = r.after![key];
    if (Math.abs(a - b) > Math.max(b * UNCHANGED_TOLERANCE, 1e-9)) {
      const fmt = (v: number): string => `$${v < 1 ? v.toFixed(decimals) : v.toFixed(2)}/M`;
      parts.push(`${label} ${fmt(b)} → ${fmt(a)} (${pctChange(b, a)})`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : "no change";
}

export function formatCalibrationReport(result: CalibrationRunResult, cancelled = false): string {
  const lines: string[] = [];
  lines.push(
    `ClinePass calibration ${cancelled ? "cancelled" : result.applied ? "complete" : "aborted (anomaly)"} — spent $${result.spentUsd.toFixed(4)}`,
  );
  if (result.anomaly) {
    lines.push(result.anomaly);
    lines.push("Prices remain unchanged.");
    return lines.join("\n");
  }

  const changed = result.results.filter((r) => r.status === "applied");
  const unchanged = result.results.filter((r) => r.status === "unchanged");
  const failed = result.results.filter((r) => r.status === "failed");

  if (changed.length === 0 && failed.length === 0) {
    lines.push("All prices unchanged — measured within 0.5% of current values.");
  } else {
    if (changed.length > 0) {
      lines.push(`Price changes (${changed.length}):`);
      for (const r of changed) lines.push(`  ${shortName(r.id).padEnd(20)} ${deltaLine(r)}`);
    }
    if (unchanged.length > 0) {
      lines.push(`Unchanged (${unchanged.length}): ${unchanged.map((r) => shortName(r.id)).join(", ")}`);
    }
  }
  for (const r of failed) {
    lines.push(`Failed (${shortName(r.id)}): ${r.notes.join("; ")} — kept previous prices`);
  }
  for (const r of result.results.filter((x) => x.cacheEngaged === false && x.after)) {
    const cr = r.after!.cacheRead;
    lines.push(`Cache not measured (${shortName(r.id)}): cacheRead kept at $${cr < 1 ? cr.toFixed(4) : cr.toFixed(2)}/M`);
  }
  return lines.join("\n");
}

/** Build the calibration file from a run (failed models are not written). */
export function buildCalibrationFile(
  result: CalibrationRunResult,
  calibratedAt = new Date().toISOString(),
  catalogVersion?: string,
): CalibrationFile {
  const models: Record<string, CalibratedRates> = {};
  for (const r of result.results) {
    if (r.status === "failed" || !r.after) continue;
    models[r.id] = {
      input: r.after.input,
      output: r.after.output,
      cacheRead: r.after.cacheRead,
      calibratedAt,
    };
  }
  // Keep the release stamp — a calibration write without it would look like
  // a foreign release on the next session and get wiped by the sync.
  return { version: 1, catalogVersion, calibratedAt, models };
}
