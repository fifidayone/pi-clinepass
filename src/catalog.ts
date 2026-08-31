/**
 * ClinePass static model catalog.
 *
 * Prices are the measured billing rates from the Cline `/usages` API
 * (verified against real usage), not the published reference table which
 * drifts from actual billing. `cacheWrite` is kept at 0: pi's cost model
 * requires the field, but we do not display or track cache-write pricing.
 *
 * Context is capped to 921,600 for models whose gateway reports ~1M
 * (pool max, not single-node) to leave headroom; max output is capped to
 * 131,072. Models under 1M keep their tested values.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingLevelMap = Readonly<Record<ThinkingLevel, string | null>>;

export interface ClinePassModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: ThinkingLevelMap;
  compat: {
    supportsDeveloperRole: false;
    cacheControlFormat: "anthropic";
    supportsLongCacheRetention: false;
  };
}

/** All 7 levels supported (off → "none"). Used when `supportedEfforts: null` + mandatory false. */
const ALL_THINKING: ThinkingLevelMap = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** All levels except off (mandatory reasoning). Used when `mandatory: true` + `supportedEfforts: null`. */
const ALL_MANDATORY: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Only max/high/low + off. Used for deepseek, glm-5.3, kimi-k3, free models. */
const MAX_HIGH_LOW: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/** Max/high/low but off not allowed (mandatory). */
const MAX_HIGH_LOW_MANDATORY: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/** Only xhigh/high + off. Used for glm-5.2. */
const XHIGH_HIGH: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: "xhigh",
  max: null,
};

/** xhigh/medium/low + off. Used for qwen3.8-max. */
const XHIGH_MEDIUM_LOW: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: null,
  xhigh: "xhigh",
  max: null,
};

/**
 * ClinePass rejects the `developer` role; the API caps at `max_tokens` /
 * `max_completion_tokens` with reasoning excluded from the completion cap,
 * so pi's default `max_completion_tokens` is correct and left unset.
 * `cacheControlFormat: "anthropic"` makes pi send `{type:"ephemeral"}`
 * (no ttl) — verified to engage real caching on ClinePass.
 * `supportsLongCacheRetention: false` keeps ttl from ever being sent
 * (ttl causes HTTP 500).
 */
const COMPAT = {
  supportsDeveloperRole: false as const,
  cacheControlFormat: "anthropic" as const,
  supportsLongCacheRetention: false as const,
};

function model(
  id: string,
  name: string,
  cost: [input: number, output: number, cacheRead: number],
  contextWindow: number,
  maxTokens: number,
  input: readonly ("text" | "image")[] = ["text"],
  thinkingLevelMap: ThinkingLevelMap = ALL_THINKING,
): ClinePassModel {
  return {
    id,
    name,
    reasoning: true,
    input,
    cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: 0 },
    contextWindow,
    maxTokens,
    thinkingLevelMap,
    compat: COMPAT,
  };
}

/** Measured prices ($/1M tokens: input/output/cacheRead) — latest verified. */
export const MODELS: readonly ClinePassModel[] = [
  // ── Free models (Cline free tier, cost 0) ──────────────────────────────
  model("cline-free/longcat-2.0", "LongCat 2.0", [0, 0, 0], 921_600, 131_072, ["text"], ALL_THINKING),
  model("z-ai/glm-5.3-flash", "GLM-5.3 Flash", [0, 0, 0], 921_600, 131_072, ["text", "image"], MAX_HIGH_LOW_MANDATORY),
  model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", [0, 0, 0], 921_600, 131_072, ["text"], MAX_HIGH_LOW),
  model("poolside/laguna-s-2.1:free", "Laguna S-2.1", [0, 0, 0], 262_144, 131_072, ["text"], ALL_THINKING),
  // ── ClinePass models (measured billing prices) ─────────────────────────
  model("cline-pass/glm-5.3-flash", "GLM-5.3 Flash", [0.15, 0.5, 0.03], 921_600, 131_072, ["text", "image"], MAX_HIGH_LOW_MANDATORY),
  model("cline-pass/glm-5.3", "GLM-5.3", [1.4, 4.4, 0.26], 921_600, 131_072, ["text"], MAX_HIGH_LOW_MANDATORY),
  model("cline-pass/glm-5.2", "GLM-5.2", [1.4, 4.4, 0.26], 921_600, 131_072, ["text"], XHIGH_HIGH),
  model("cline-pass/kimi-k2.7-code", "Kimi K2.7 Code", [1.58, 6.67, 0.32], 262_144, 131_072, ["text", "image"], ALL_MANDATORY),
  model("cline-pass/kimi-k2.6", "Kimi K2.6", [1.58, 6.67, 0.27], 262_144, 131_072, ["text", "image"], ALL_THINKING),
  model("cline-pass/kimi-k3", "Kimi K3", [6.0, 30.0, 0.6], 921_600, 131_072, ["text", "image"], MAX_HIGH_LOW),
  model("cline-pass/deepseek-v4-pro", "DeepSeek V4 Pro", [1.65, 4.95, 0.06], 921_600, 131_072, ["text"], MAX_HIGH_LOW),
  model("cline-pass/deepseek-v4-flash", "DeepSeek V4 Flash", [0.44, 1.32, 0.014], 921_600, 131_072, ["text"], MAX_HIGH_LOW),
  model("cline-pass/mimo-v2.5", "MiMo-V2.5", [0.14, 0.28, 0.0028], 921_600, 131_072, ["text", "image"], ALL_THINKING),
  model("cline-pass/mimo-v2.5-pro", "MiMo-V2.5-Pro", [0.435, 0.87, 0.0036], 921_600, 131_072, ["text"], ALL_THINKING),
  model("cline-pass/minimax-m3", "MiniMax M3", [0.5, 2.0, 0.1], 921_600, 131_072, ["text", "image"], ALL_THINKING),
  model("cline-pass/qwen3.7-plus", "Qwen3.7 Plus", [0.67, 2.67, 0.07], 921_600, 131_072, ["text", "image"], ALL_THINKING),
  model("cline-pass/qwen3.7-max", "Qwen3.7 Max", [4.17, 12.5, 0.83], 921_600, 131_072, ["text"], ALL_THINKING),
  model("cline-pass/qwen3.8-max", "Qwen3.8 Max", [2.75, 8.25, 0.34], 921_600, 131_072, ["text", "image"], XHIGH_MEDIUM_LOW),
];

export function modelIds(): string[] {
  return MODELS.map((m) => m.id);
}

/** True for the Cline free-tier models — derived from the catalog itself
 * (cost 0), so adding a free model never needs a second edit here. */
export function isFreeModel(id: string): boolean {
  return MODELS.some((m) => m.id === id && m.cost.input === 0);
}
