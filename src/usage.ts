/**
 * ClinePass real-time billing: server-truth usage, plan limits, and the
 * status meter.
 *
 * Turn cost and session total come from Cline's `/usages` API (the same
 * billing the subscription meter uses), not from local price estimation.
 * The meter updates pi's footer status bar — no chat-stream noise.
 *
 * Tracking runs on a background queue: `message_end` sits on pi's critical
 * path (message finalization + agent loop), so polling the billing API must
 * never block it. Records are matched to the completed message by freshness
 * and model id, with a session-start baseline so stale records from earlier
 * sessions are never adopted as this session's cost.
 */

import {
  DEFAULT_API_BASE,
  WORKOS_REFRESH_MARGIN_MS,
  refreshWorkosToken,
  type ClineAuthCredentials,
} from "./workos.js";
import { isFreeModel, type ClinePassModel } from "./catalog.js";
import { getEffectiveModels } from "./pricing.js";
import {
  persistOAuthCredential,
  resolvePiStoredCredential,
  type AuthOptions,
} from "./auth.js";

export const PROVIDER_NAME = "clinepass";

export interface UsageRecord {
  id: string;
  /** The gateway request id — exact correlation key for probe matching. */
  generationId?: string;
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD (costUsd is micro-units from the API: /1e8). */
  costUsd: number;
  createdAt: string;
}

export interface PlanLimits {
  planName?: string;
  isActive?: boolean;
  currentPeriodEnd?: string;
  fiveHour: { usedPercent: number; limitUsd: number | undefined; resetsAt?: string };
  sevenDay: { usedPercent: number; limitUsd: number | undefined; resetsAt?: string };
  thirtyDay: { usedPercent: number; limitUsd: number | undefined; resetsAt?: string };
}

export interface UsageOptions extends AuthOptions {
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
}

const USAGES_PER_PAGE = 50;
/** Records scanned per poll when matching a turn to its usage record. */
const TRACKING_SCAN_LIMIT = 5;
const FETCH_TIMEOUT_MS = 15_000;
/** A record created this long before the turn started is not this turn's. */
const STALE_RECORD_SKEW_MS = 2 * 60 * 1000;
/** A record created more than this long after the turn ended belongs to a
 * later turn (or another concurrent window), never to this one — the slack
 * only covers server/client clock skew. */
const FUTURE_RECORD_SKEW_MS = 10 * 1000;
/** Poll attempts for the server to flush the turn's usage record. */
const TRACKING_POLL_ATTEMPTS = 3;
const TRACKING_POLL_INTERVAL_MS = 400;
/** Minimum remaining TTL for the cached token to be reused. */
const TOKEN_CACHE_MIN_TTL_MS = 30_000;

// ─── ANSI color support ────────────────────────────────────────────────────
// pi's TUI renders ANSI in the footer status bar and status messages.
// Respect NO_COLOR and allow opt-out via CLINEPASS_COLOR=0.
const USE_COLOR = !process.env.NO_COLOR && process.env.CLINEPASS_COLOR !== "0";
const c = {
  red: (s: string) => (USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string) => (USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s: string) => (USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (USE_COLOR ? `\x1b[2m${s}\x1b[0m` : s),
};

/** Warning sign in text presentation (U+26A0 + VS15) — not the emoji variant. */
const WARN = "\u26A0\uFE0E";

/** Reset all ANSI attributes — clears pi's outer dim wrapper around report text. */
const CLEAR = USE_COLOR ? "\x1b[0m" : "";

/** Color by usage level: <50 green, 50-79 yellow, ≥80 red. */
function usageColor(p: number): (s: string) => string {
  return p >= 80 ? c.red : p >= 50 ? c.yellow : c.green;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

/**
 * The usage record's model id, in catalog form. Real data: `aiModelName`
 * for paid ClinePass models already carries the catalog id
 * ("cline-pass/mimo-v2.5-pro"); `metadata.raw_model` is an upstream vendor
 * path ("xiaomi/mimo-v2.5-pro") and must NOT take precedence. Only the
 * free deepseek route leaves `aiModelName` bare, and free models are
 * skipped before matching anyway.
 */
function normalizeRecordModel(item: Record<string, unknown>): string {
  const name = stringValue(item.aiModelName);
  if (name) return name;
  return stringValue(isRecord(item.metadata) ? item.metadata.raw_model : undefined) ?? "";
}

// ─── Token resolution (single source, shared with auth.ts) ────────────────

interface ResolvedToken {
  token: string;
  /** When the token should be re-resolved (ms epoch). */
  expiresAt: number;
  /**
   * Identity of the stored credential this token was resolved from
   * (`pi-store:<accessToken>`). `/logout` deletes the stored credential
   * without any extension event, so every call re-reads the store (a cheap
   * sync read) and drops the cache when the identity changes — the meter
   * must never keep using a logged-out or switched credential.
   */
  identity: string;
}

let tokenCache: ResolvedToken | undefined;
let userIdCache: { token: string; userId: string } | undefined;

/**
 * Resolve a usable bearer token for Cline API requests.
 *
 * Single source of truth: pi's stored credential for the `clinepass`
 * provider (`~/.pi/agent/auth.json` → `clinepass`) — the identity every
 * login method converges to (paste / device flow / reuse), so the meter
 * always measures the account chat actually uses. The token is cached to avoid
 * a network refresh on every call, but the store is re-read each time so
 * `/logout` (or switching accounts) takes effect immediately.
 */
export async function getActiveToken(options: UsageOptions = {}): Promise<string | undefined> {
  const credential = resolvePiStoredCredential(options);
  if (!credential) {
    tokenCache = undefined;
    return undefined;
  }
  const identity = `pi-store:${credential.accessToken}`;
  // Same credential still stored and cached token has lifetime: reuse it
  // (skips the potentially-networking refresh below).
  if (tokenCache?.identity === identity && tokenCache.expiresAt > Date.now() + TOKEN_CACHE_MIN_TTL_MS) {
    return tokenCache.token;
  }

  const resolved = await freshenCredential(credential, options);
  tokenCache = { ...resolved, identity };
  return resolved.token;
}

/** Turn the stored credential into a request token, refreshing near expiry. */
async function freshenCredential(
  clineAuth: ClineAuthCredentials,
  options: UsageOptions,
): Promise<Omit<ResolvedToken, "identity">> {
  if (clineAuth.expiresAt > Date.now() + WORKOS_REFRESH_MARGIN_MS) {
    return { token: clineAuth.accessToken, expiresAt: clineAuth.expiresAt - WORKOS_REFRESH_MARGIN_MS };
  }
  try {
    const refreshed = await refreshWorkosToken(
      { access: clineAuth.accessToken, refresh: clineAuth.refreshToken, expires: clineAuth.expiresAt },
      { fetch: options.fetch, apiBase: options.apiBase ?? DEFAULT_API_BASE },
    );
    // Persist rotated refresh tokens back to pi's auth.json — if the server
    // rotates single-use refresh tokens, discarding the new one would leave
    // pi's stored credential dead and force a re-login.
    if (refreshed.refresh !== clineAuth.refreshToken) {
      await persistOAuthCredential(refreshed, options).catch(() => {});
    }
    return { token: refreshed.access, expiresAt: refreshed.expires };
  } catch {
    // Keep the stale token for a short window; pi's own refresh on the next
    // chat request usually repairs the stored credential.
    return { token: clineAuth.accessToken, expiresAt: Date.now() + TOKEN_CACHE_MIN_TTL_MS };
  }
}

// ─── API fetchers ─────────────────────────────────────────────────────────

async function getJson(path: string, options: UsageOptions): Promise<Record<string, unknown> | undefined> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const token = await getActiveToken(options);
  if (!token) return undefined;
  const response = await fetchFn(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 401) {
    // Cached token rejected — drop caches so the next call re-resolves.
    tokenCache = undefined;
    userIdCache = undefined;
  }
  if (!response.ok) return undefined;
  const body: unknown = await response.json().catch(() => undefined);
  return isRecord(body) ? body : undefined;
}

async function getUserId(options: UsageOptions): Promise<string | undefined> {
  const token = await getActiveToken(options);
  if (!token) return undefined;
  if (userIdCache?.token === token) return userIdCache.userId;
  const json = await getJson("/api/v1/users/me", options);
  const id = stringValue(isRecord(json?.data) ? json.data.id : json?.id);
  if (id) userIdCache = { token, userId: id };
  return id;
}

/**
 * Fetch recent usage records (newest first) from Cline's billing API.
 * `costUsd` arrives as micro-units; divide by 1e8 to get USD.
 */
export async function fetchUsageRecords(
  options: UsageOptions = {},
  limit = USAGES_PER_PAGE,
): Promise<UsageRecord[] | undefined> {
  const userId = await getUserId(options);
  if (!userId) return undefined;
  const json = await getJson(`/api/v1/users/${encodeURIComponent(userId)}/usages?limit=${limit}`, options);
  const items = isRecord(json?.data) && Array.isArray(json.data.items) ? json.data.items : undefined;
  if (!items) return undefined;
  return items
    .filter(isRecord)
    .map((item) => {
      const promptTokens = numberValue(item.promptTokens) ?? 0;
      const cachedTokens = numberValue(item.cachedTokens) ?? 0;
      const completionTokens = numberValue(item.completionTokens) ?? 0;
      const rawCostUsd = numberValue(item.costUsd) ?? 0;
      return {
        id: stringValue(item.id) ?? "",
        generationId: stringValue(item.generationId),
        // The API's `aiModelName` is bare (e.g. "deepseek-v4-flash"); the
        // catalog/message ids carry the vendor path ("deepseek/deepseek-v4-flash")
        // so normalize with `metadata.raw_model` when present.
        model: normalizeRecordModel(item),
        promptTokens,
        cachedTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd: rawCostUsd / 100_000_000,
        createdAt: stringValue(item.createdAt) ?? new Date().toISOString(),
      };
    })
    .filter((r) => r.id);
}

/**
 * Rolling plan limits for the meter and the /clinepass report: percent used
 * (5h/weekly/monthly) plus the real cap thresholds from the plan
 * entitlements (micro-units → USD). Read live from the API on every call —
 * no caching. Limit amounts are `undefined` when the plan exposes no cap
 * entitlement — no invented fallback numbers.
 */
export async function fetchPlanLimits(options: UsageOptions = {}): Promise<PlanLimits | undefined> {
  const [limitsJson, planJson] = await Promise.all([
    getJson("/api/v1/users/me/plan/usage-limits", options),
    getJson("/api/v1/users/me/plan", options),
  ]);
  if (!limitsJson) return undefined;

  const limits = Array.isArray(isRecord(limitsJson.data) ? limitsJson.data.limits : undefined)
    ? (limitsJson.data as { limits: unknown[] }).limits
    : [];
  const byType = new Map<string, { percentUsed?: number; resetsAt?: string }>();
  for (const item of limits.filter(isRecord)) {
    const type = stringValue(item.type);
    if (!type) continue;
    byType.set(type, {
      percentUsed: numberValue(item.percentUsed),
      resetsAt: stringValue(item.resetsAt),
    });
  }

  const plan = isRecord(planJson?.data) ? planJson.data : planJson;
  const planDetails = isRecord(plan?.plan) ? plan.plan : undefined;
  const entitlements = isRecord(planDetails?.entitlements) ? planDetails.entitlements : undefined;
  const clinePass = isRecord(entitlements?.cline_pass) ? entitlements.cline_pass : undefined;
  const cap = isRecord(clinePass?.inferenceCapThreshold) ? clinePass.inferenceCapThreshold : undefined;
  const microToUsd = (v: unknown): number | undefined => {
    const n = numberValue(v);
    return n === undefined ? undefined : n / 100_000_000;
  };

  const fiveHour = byType.get("five_hour");
  const weekly = byType.get("weekly");
  const monthly = byType.get("monthly");

  return {
    planName: stringValue(planDetails?.displayName) ?? "Cline Pass",
    isActive: isRecord(plan?.plan) ? (plan.plan.isActive as boolean | undefined) : undefined,
    currentPeriodEnd: stringValue(plan?.currentPeriodEnd),
    fiveHour: {
      usedPercent: fiveHour?.percentUsed ?? 0,
      limitUsd: microToUsd(cap?.last5HoursUsageCostUSDPerUser),
      resetsAt: fiveHour?.resetsAt,
    },
    sevenDay: {
      usedPercent: weekly?.percentUsed ?? 0,
      limitUsd: microToUsd(cap?.last7daysUsageCostUSDPerUser),
      resetsAt: weekly?.resetsAt,
    },
    thirtyDay: {
      usedPercent: monthly?.percentUsed ?? 0,
      limitUsd: microToUsd(cap?.last30daysUsageCostUSDPerUser),
      resetsAt: monthly?.resetsAt,
    },
  };
}

// ─── Meter ────────────────────────────────────────────────────────────────

export interface MeterContext {
  hasUI?: boolean;
  ui?: {
    setStatus?: (key: string, text: string | undefined) => void;
    notify?: (msg: string, type: "info" | "warning" | "error") => void;
  };
  model?: { provider?: string; id?: string };
  sessionManager?: {
    getEntries?: () => unknown[];
  };
}

function isClinePassContext(ctx: MeterContext): boolean {
  const provider = ctx.model?.provider;
  return provider === PROVIDER_NAME || provider === "cline-pass";
}

/** Colored progress bar + percentage segment for the status line. */
function formatLimitSegment(usedPercent: number, resetsAt?: string): string {
  const color = usageColor(usedPercent);
  const bar = color(renderBar(usedPercent));
  const pct = color(`${usedPercent}%`);
  const reset = resetsAt ? ` (resets ${formatTime(resetsAt)})` : "";
  return `${bar} ${pct}${reset}`;
}

/**
 * Wrap a status-line payload in box-drawing side rails so the meter stands
 * out from pi's other footer statuses.
 */
function meterBox(payload: string): string {
  return `│ ${payload} │`;
}

/**
 * Format a USD price keeping only meaningful decimals: strip trailing zeros
 * while keeping at least 2 decimals for values ≥ 1 and exact zeros.
 * (1.40, 30.00, 0.26, 0.317, 0.0028)
 */
function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  const stripped = value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const decimals = stripped.includes(".") ? stripped.length - stripped.indexOf(".") - 1 : 0;
  return `$${decimals >= 2 ? stripped : value.toFixed(2)}`;
}

function renderBar(percent: number, length = 10): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * length);
  return `[${"█".repeat(filled)}${"░".repeat(length - filled)}]`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Sum the per-session cost entries appended by writeCostEntry.
 *
 * Aggregates over ALL session entries — including turns later abandoned
 * by rewind/fork — matching pi's own billing philosophy ("reflect what
 * was actually billed"): those API calls were really made, so their
 * spend counts even if the conversation moved on. Cost entries are kept
 * across compaction boundaries — compaction is context management, not
 * cost accounting.
 */
export function sumSessionEntries(
  sessionManager: { getEntries?: () => unknown[] } | undefined,
): number {
  let total = 0;
  for (const entry of sessionManager?.getEntries?.() ?? []) {
    if (!isRecord(entry)) continue;
    if (entry.type === "custom" && entry.customType === "clinepass-cost") {
      total += numberValue(isRecord(entry.data) ? entry.data.costUsd : undefined) ?? 0;
    }
  }
  return total;
}

function clearMeter(ctx: MeterContext): void {
  try {
    ctx.ui?.setStatus?.("clinepass-cost", undefined);
  } catch {
    // Meter updates are best-effort; a stale ctx (session replaced/reloaded)
    // must never crash the extension.
  }
}

/**
 * message_end entry point: queue billing tracking in the background.
 * `message_end` handlers are awaited inline by pi (they gate message
 * finalization and the agent loop), so the usage-record poll must run
 * detached. Tasks are serialized on an internal chain to preserve
 * per-message order of session cost entries.
 * Returns the queued task (resolves when tracking for this message is done).
 */
export function handleUsageTracking(
  event: { message?: unknown },
  ctx: MeterContext,
  writeEntry: (usage: UsageRecord) => void,
  options: UsageOptions = {},
): Promise<void> {
  // Extract everything from the event synchronously — the event object may
  // be reused after this handler returns.
  const msg = isRecord(event.message) ? event.message : undefined;
  if (!msg) return Promise.resolve();
  // A user message marks the turn boundary: reset the per-turn accumulator.
  if (msg.role === "user") {
    turnCostMu = 0;
    return Promise.resolve();
  }
  if (msg.role !== "assistant") return Promise.resolve();

  const provider = typeof msg.provider === "string" ? msg.provider : ctx.model?.provider;
  if (provider !== PROVIDER_NAME && provider !== "cline-pass") return Promise.resolve();

  const rawModelId = typeof msg.model === "string" ? msg.model : ctx.model?.id ?? "";
  const modelId = rawModelId.toLowerCase();
  if (trackingPaused) {
    clearMeter(ctx);
    return Promise.resolve();
  }
  if (isFreeModel(modelId)) {
    clearMeter(ctx);
    return Promise.resolve();
  }
  // Logged out (or never logged in): no account to bill against, so no
  // tracking. The credential check re-runs inside the tracking queue too,
  // so a logout mid-turn stops the poll as well.
  if (!resolvePiStoredCredential()) {
    tokenCache = undefined;
    clearMeter(ctx);
    return Promise.resolve();
  }

  const info = { modelId, turnStartMs: Date.now() };
  const task = trackingQueue.then(() => trackUsage(info, ctx, writeEntry, options));
  trackingQueue = task.catch(() => {});
  return task;
}

let trackingQueue: Promise<void> = Promise.resolve();
/** Newest usage-record id seen/adopted; records at or before it are old news. */
let lastSeenUsageId: string | undefined;
/** Running cost of the current turn (micro-$): every adopted record adds in,
 * so "Turn:" reflects the whole turn including tool-calling rounds. */
let turnCostMu = 0;

let trackingPaused = false;

/**
 * Suspend meter tracking while price calibration runs: probe records hit the
 * same /usages feed with the same model ids, so the meter must not adopt them
 * as session spend. Resumed by `reseedUsageBaseline` after calibration.
 */
export function setUsageTrackingPaused(paused: boolean): void {
  trackingPaused = paused;
}

/**
 * Drop the tracking baseline and re-seed from the newest /usages record —
 * called after calibration so probe spend can never be adopted by later turns.
 */
export async function reseedUsageBaseline(options: UsageOptions = {}): Promise<void> {
  lastSeenUsageId = undefined;
  await seedUsageBaseline(options);
}

async function trackUsage(
  info: { modelId: string; turnStartMs: number },
  ctx: MeterContext,
  writeEntry: (usage: UsageRecord) => void,
  options: UsageOptions,
): Promise<void> {
  try {
    // The server flushes the usage record shortly after the turn completes;
    // poll briefly, then fall back to a late background check so the session
    // total never under-counts. Re-check the stored credential on every poll
    // attempt and before each late check — a /logout mid-turn must stop all
    // billing traffic immediately, and the meter's token cache is dropped so
    // no stale token is reused afterwards.
    let usage: UsageRecord | undefined;
    for (let attempt = 0; attempt < TRACKING_POLL_ATTEMPTS && !usage; attempt++) {
      await sleep(TRACKING_POLL_INTERVAL_MS);
      if (!resolvePiStoredCredential(options)) {
        tokenCache = undefined;
        userIdCache = undefined;
        clearMeter(ctx);
        return;
      }
      const records = await fetchUsageRecords(options, TRACKING_SCAN_LIMIT);
      if (!records || records.length === 0) continue;
      usage = adoptUsageRecord(records, info.turnStartMs, info.modelId);
    }

    if (!usage) {
      scheduleLateRecord(info, ctx, writeEntry, options);
      return;
    }
    turnCostMu += Math.round(usage.costUsd * 1e8);
    writeEntry(usage);
    await updateMeter(ctx, options);
  } catch {
    // Billing tracking is best-effort; never let it crash the turn.
  }
}

function recordCreatedMs(record: UsageRecord): number {
  const ms = Date.parse(record.createdAt);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/**
 * A record is foreign to this turn when it sits outside the freshness window:
 * created well before the turn started (an earlier session/turn) or created
 * after it ended beyond clock-skew slack (a later turn / concurrent window).
 */
function isForeignRecord(record: UsageRecord, turnStartMs: number): boolean {
  const created = recordCreatedMs(record);
  return (
    created < turnStartMs - STALE_RECORD_SKEW_MS ||
    created > turnStartMs + FUTURE_RECORD_SKEW_MS
  );
}

/**
 * Whether a usage record's model matches the message/catalog model id.
 * Real data: `aiModelName` matches the catalog id exactly (after
 * normalizeRecordModel). Only the free deepseek route differs, and it is
 * skipped before matching.
 */
export function modelsMatch(recordModel: string, modelId: string): boolean {
  return recordModel.toLowerCase() === modelId.toLowerCase();
}

/**
 * Pick this turn's usage record from the newest-first `records` list.
 * A record is adopted only when it is unseen, fresh (created inside the
 * freshness window around this turn — clock-skew slack on both sides), and
 * billed for the same model —
 * so stale records from earlier sessions and foreign-model records on the
 * same account are never misattributed. Mutates the module baseline.
 */
export function adoptUsageRecord(
  records: UsageRecord[],
  turnStartMs: number,
  modelId?: string,
): UsageRecord | undefined {
  for (const record of records) {
    if (record.id === lastSeenUsageId) return undefined; // reached seen territory
    if (isForeignRecord(record, turnStartMs)) continue;
    if (modelId && record.model && !modelsMatch(record.model, modelId)) continue;
    lastSeenUsageId = record.id;
    return record;
  }
  return undefined;
}

/**
 * Seed the tracking baseline with the newest existing usage record so the
 * first tracked turn of a session cannot adopt a record from before the
 * session (which would show a phantom cost). Best-effort, idempotent.
 */
let seedingBaseline = false;
async function seedUsageBaseline(options: UsageOptions): Promise<void> {
  if (lastSeenUsageId !== undefined || seedingBaseline) return;
  seedingBaseline = true;
  try {
    const records = await fetchUsageRecords(options, 1);
    if (records && records.length > 0 && lastSeenUsageId === undefined) {
      lastSeenUsageId = records[0].id;
    }
  } catch {
    // best-effort
  } finally {
    seedingBaseline = false;
  }
}

function scheduleLateRecord(
  info: { modelId: string; turnStartMs: number },
  ctx: MeterContext,
  writeEntry: (usage: UsageRecord) => void,
  options: UsageOptions,
): void {
  const run = async (delayMs: number): Promise<void> => {
    await sleep(delayMs);
    // Late checks re-verify the stored credential: a /logout between the
    // turn and the late poll must stop all billing traffic.
    if (!resolvePiStoredCredential(options)) {
      tokenCache = undefined;
      userIdCache = undefined;
      return;
    }
    const records = await fetchUsageRecords(options, TRACKING_SCAN_LIMIT);
    if (!records || records.length === 0) return;
    const late = adoptUsageRecord(records, info.turnStartMs, info.modelId);
    if (!late) return;
    turnCostMu += Math.round(late.costUsd * 1e8);
    writeEntry(late);
    await updateMeter(ctx, options);
  };
  void run(3000).catch(() => {});
  void run(8000).catch(() => {});
}

async function updateMeter(ctx: MeterContext, options: UsageOptions): Promise<void> {
  const sessionTotal = sumSessionEntries(ctx.sessionManager);
  const turnTotal = turnCostMu / 1e8;
  if (turnTotal === 0 && sessionTotal === 0) {
    clearMeter(ctx);
    return;
  }

  const limits = await fetchPlanLimits(options);
  const limitSeg = limits
    ? ` | 5h: ${formatLimitSegment(limits.fiveHour.usedPercent, limits.fiveHour.resetsAt)}`
    : "";
  const text = meterBox(
    `Turn: $${turnTotal.toFixed(5)} · ${c.dim(`Session: $${sessionTotal.toFixed(5)}`)}${limitSeg}`,
  );
  try {
    ctx.ui?.setStatus?.("clinepass-cost", text);
  } catch {
    // best-effort meter update; stale ctx must not crash
  }
}

/**
 * session_start / model_select handler: show a placeholder meter (and plan
 * limits) before the first turn completes; clear it for free models or when
 * the session is not on ClinePass. Also seeds the usage-record baseline so
 * the first tracked turn cannot adopt a pre-session record.
 */
export async function handleInitialMeter(ctx: MeterContext, options: UsageOptions = {}): Promise<void> {
  try {
    if (!isClinePassContext(ctx)) {
      clearMeter(ctx);
      return;
    }
    // The meter tracks the logged-in account only; before /login there is
    // nothing to show.
    if (!resolvePiStoredCredential(options)) {
      clearMeter(ctx);
      return;
    }
    void seedUsageBaseline(options);
    const currentModelId = ctx.model?.id?.toLowerCase() ?? "";
    if (isFreeModel(currentModelId)) {
      clearMeter(ctx);
      return;
    }
    const limits = await fetchPlanLimits(options);
    const sessionTotal = sumSessionEntries(ctx.sessionManager);
    const limitSeg = limits
      ? ` | 5h: ${formatLimitSegment(limits.fiveHour.usedPercent, limits.fiveHour.resetsAt)}`
      : "";
    const sessionDisplay = sessionTotal > 0
      ? ` · ${c.dim(`Session: $${sessionTotal.toFixed(5)}`)}`
      : "";
    ctx.ui?.setStatus?.("clinepass-cost", meterBox(`Turn: $0.00000${sessionDisplay}${limitSeg}`));
  } catch {
    // best-effort meter update; stale ctx must not crash
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @internal Reset module-level caches and tracking state (tests only). */
export function resetUsageTrackingForTest(): void {
  tokenCache = undefined;
  userIdCache = undefined;
  lastSeenUsageId = undefined;
  seedingBaseline = false;
  trackingQueue = Promise.resolve();
  trackingPaused = false;
  turnCostMu = 0;
}

// ─── /clinepass report ────────────────────────────────────────────────────

/** Clean display name for the report: plain catalog names (no badge — the
 * report's own columns carry the numbers). */
function reportName(m: ClinePassModel): string {
  return m.name;
}

function formatResetDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ` (resets ${formatTime(iso)})`;
}

function formatResetDateWithDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = formatTime(iso);
  if (!time) return "";
  const datePart = d.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
  return ` (resets ${datePart}, ${time})`;
}

function formatExpiryDate(iso?: string): string {
  const p = formatExpiryParts(iso);
  return `${p.suffix} (${p.remaining})${p.warn ? c.yellow(p.warn) : ""}`;
}

/** Expiry split into pieces — the meter block arranges them on separate
 * lines; the classic report composes one line. */
interface ExpiryParts {
  /** " • Active until Aug 30, 2026 02:14 PM" */
  suffix: string;
  /** "2h remaining" */
  remaining: string;
  /** " - ⚠︎ Expiring soon!" — only when expiring within 3 days */
  warn: string;
}

function formatExpiryParts(iso?: string): ExpiryParts {
  if (!iso) return { suffix: "", remaining: "", warn: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { suffix: "", remaining: "", warn: "" };
  const remainingMs = d.getTime() - Date.now();
  const dateStr = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  let remaining: string;
  if (remainingMs <= 0) {
    remaining = "expired";
  } else if (remainingMs < 3_600_000) {
    remaining = `${Math.max(1, Math.round(remainingMs / 60_000))}m remaining`;
  } else if (remainingMs < 86_400_000) {
    remaining = `${Math.floor(remainingMs / 3_600_000)}h remaining`;
  } else {
    remaining = `${Math.floor(remainingMs / 86_400_000)}d remaining`;
  }
  const isExpiringSoon = remainingMs <= 3 * 86_400_000;
  const warn = isExpiringSoon ? ` - ${WARN} Expiring soon!` : "";
  return { suffix: ` • Active until ${dateStr} ${timeStr}`, remaining, warn };
}

function formatLimitUsd(value: number | undefined): string {
  return value === undefined ? "n/a" : `$${value.toFixed(2)}`;
}

/** Structured pieces of the /clinepass report — the two-column view composes
 * these; `getCapReport` renders the same data as one classic string. */

export interface CapReportData {
  title: string;
  priceHeader: string;
  /** Price table rows, free tier first, free/paid divider included. */
  priceRows: string[];
  /** Full-width plan + limit rows (classic layout). */
  planRows: string[];
  /** The meter block — plan + expiry + limit bars, original formats. */
  meter: string[];
  /** The price table's exact width (header/rows/dividers all match it). */
  priceTableW: number;
}

function buildCapReportData(limits: PlanLimits): CapReportData {
  const effective = getEffectiveModels();
  const free = effective.filter((m) => m.cost.input === 0);
  const paid = effective.filter((m) => m.cost.input > 0);
  // The name column must fit the longest row — names exceed 20 chars (e.g.
  // "DeepSeek V4 Flash (free)" is 24) and a hardcoded 47-wide table would
  // truncate those rows and cut off the cache-read column.
  const nameW = Math.max(
    20,
    ...[...free.map((m) => reportName(m) + " (free)"), ...paid.map((m) => reportName(m))].map((s) => s.length),
  );
  const priceTableW = nameW + 9 + 9 + 9;
  // Free tier on top, divider, then paid — "(free)" marks the free rows.
  const priceRow = (m: ClinePassModel, suffix = ""): string =>
    `${(reportName(m) + suffix).padEnd(nameW)}${formatUsd(m.cost.input).padStart(9)}${formatUsd(m.cost.output).padStart(9)}${formatUsd(m.cost.cacheRead).padStart(9)}`;
  const priceRows = [
    ...free.map((m) => priceRow(m, " (free)")),
    "-".repeat(priceTableW),
    ...paid.map((m) => priceRow(m)),
  ];

  const reset5h = formatResetDate(limits.fiveHour.resetsAt);
  const reset7d = formatResetDateWithDate(limits.sevenDay.resetsAt);
  const reset30d = formatResetDateWithDate(limits.thirtyDay.resetsAt);
  const expiryInfo = formatExpiryDate(limits.currentPeriodEnd);

  const col5h = usageColor(limits.fiveHour.usedPercent);
  const col7d = usageColor(limits.sevenDay.usedPercent);
  const col30d = usageColor(limits.thirtyDay.usedPercent);

  const bar5h = col5h(renderBar(limits.fiveHour.usedPercent, 10));
  const bar7d = col7d(renderBar(limits.sevenDay.usedPercent, 10));
  const bar30d = col30d(renderBar(limits.thirtyDay.usedPercent, 10));

  const pct5h = col5h(`${limits.fiveHour.usedPercent}%`.padStart(4, " "));
  const pct7d = col7d(`${limits.sevenDay.usedPercent}%`.padStart(4, " "));
  const pct30d = col30d(`${limits.thirtyDay.usedPercent}%`.padStart(4, " "));

  const planName = c.bold(limits.planName ?? "Cline Pass");
  const planRows = [
    `${planName}${expiryInfo}`,
    "-".repeat(71),
    `5-Hour Limit  (${formatLimitUsd(limits.fiveHour.limitUsd)}) : ${bar5h} ${pct5h}${reset5h}`,
    `Weekly Limit  (${formatLimitUsd(limits.sevenDay.limitUsd)}) : ${bar7d} ${pct7d}${reset7d}`,
    `Monthly Limit (${formatLimitUsd(limits.thirtyDay.limitUsd)}) : ${bar30d} ${pct30d}${reset30d}`,
  ];

  // The meter block, original formats minus the redundant "Limit" word and
  // with breathing room between rows — it is the primary read of the modal.
  const expiry = formatExpiryParts(limits.currentPeriodEnd);
  const meterBar = (label: string, limitUsd: number | undefined, bar: string, pct: string, reset: string): string =>
    `${label.padEnd(8)}(${formatLimitUsd(limitUsd)}) : ${bar} ${pct}${reset}`;
  const meter = [
    `${planName} ${expiry.remaining ? c.yellow(`(${expiry.remaining})`) : ""}${expiry.warn ? c.yellow(expiry.warn) : ""}`,
    c.dim(expiry.suffix.trim()),
    "",
    meterBar("5-Hour", limits.fiveHour.limitUsd, bar5h, pct5h, reset5h),
    "",
    meterBar("Weekly", limits.sevenDay.limitUsd, bar7d, pct7d, reset7d),
    "",
    meterBar("Monthly", limits.thirtyDay.limitUsd, bar30d, pct30d, reset30d),
  ];

  return {
    title: c.bold("ClinePass Model Rates ($ / 1M tokens)"),
    priceHeader: c.bold("MODEL".padEnd(nameW) + "INPUT".padStart(9) + "OUTPUT".padStart(9) + "CACHE-R".padStart(9)),
    priceRows,
    planRows,
    meter,
    priceTableW,
  };
}

/** Structured report data for the dashboard view; a string return is the
 * error message (not logged in / API unreachable). */
export async function getCapReportData(options: UsageOptions = {}): Promise<CapReportData | string> {
  const limits = await fetchPlanLimits(options);
  if (!limits) {
    return `${WARN} [ClinePass] Unable to retrieve plan limits. Please ensure you are logged in via \`pi /login\`.`;
  }
  return buildCapReportData(limits);
}

/** The classic one-string report (headless mode and notifications). */
export async function getCapReport(options: UsageOptions = {}): Promise<string> {
  const result = await getCapReportData(options);
  if (typeof result === "string") return result;
  return [
    CLEAR + result.title,
    "",
    result.priceHeader,
    "-".repeat(result.priceTableW),
    ...result.priceRows,
    "-".repeat(result.priceTableW),
    "",
    ...result.planRows,
  ].join("\n");
}
