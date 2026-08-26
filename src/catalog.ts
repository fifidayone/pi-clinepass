/**
 * ClinePass static model catalog.
 *
 * Prices are the measured billing rates from the Cline `/usages` API
 * (verified against real usage), not the published reference table which
 * drifts from actual billing. `cacheWrite` is kept at 0: pi's cost model
 * requires the field, but we do not display or track cache-write pricing.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingLevelMap = Readonly<Record<ThinkingLevel, string | null>>;

export interface ClinePassModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ["text"];
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

/** All levels supported (off → "none"), minimal unsupported. */
const FULL_THINKING: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** ox-alpha requires reasoning upstream: off → null (unsupported). */
const OX_ALPHA_THINKING: ThinkingLevelMap = {
  ...FULL_THINKING,
  off: null,
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
  thinkingLevelMap: ThinkingLevelMap = FULL_THINKING,
): ClinePassModel {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: cost[0], output: cost[1], cacheRead: cost[2], cacheWrite: 0 },
    contextWindow,
    maxTokens,
    thinkingLevelMap,
    compat: COMPAT,
  };
}

/** Measured prices ($/1M tokens: input/output/cacheRead). */
export const MODELS: readonly ClinePassModel[] = [
  // ── Free models (Cline free tier, cost 0) ──────────────────────────────
  model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (Cline Free)", [0, 0, 0], 1_024_000, 384_000),
  model("stealth/ox-alpha", "Ox Alpha (Cline Free)", [0, 0, 0], 1_048_576, 131_072, OX_ALPHA_THINKING),
  model("poolside/laguna-s-2.1:free", "Poolside Laguna S-2.1 (Cline Free)", [0, 0, 0], 262_144, 32_768),
  // ── ClinePass models (measured billing prices) ─────────────────────────
  model("cline-pass/glm-5.3", "GLM-5.3 (ClinePass)", [1.4, 4.4, 0.26], 1_048_576, 131_072),
  model("cline-pass/glm-5.2", "GLM-5.2 (ClinePass)", [1.4, 4.4, 0.26], 1_048_576, 262_144),
  model("cline-pass/kimi-k2.7-code", "Kimi K2.7 Code (ClinePass)", [1.58, 6.67, 0.317], 262_144, 262_144),
  model("cline-pass/kimi-k2.6", "Kimi K2.6 (ClinePass)", [1.58, 6.67, 0.267], 262_144, 262_144),
  model("cline-pass/kimi-k3", "Kimi K3 (ClinePass)", [6.0, 30.0, 0.6], 1_048_576, 1_048_576),
  model("cline-pass/deepseek-v4-pro", "DeepSeek V4 Pro (ClinePass)", [1.65, 4.95, 0.06], 1_024_000, 384_000),
  model("cline-pass/deepseek-v4-flash", "DeepSeek V4 Flash (ClinePass)", [0.44, 1.32, 0.014], 1_024_000, 384_000),
  model("cline-pass/mimo-v2.5", "MiMo-V2.5 (ClinePass)", [0.14, 0.28, 0.0028], 1_048_576, 131_072),
  model("cline-pass/mimo-v2.5-pro", "MiMo-V2.5-Pro (ClinePass)", [0.435, 0.87, 0.0036], 1_048_576, 131_072),
  model("cline-pass/minimax-m3", "MiniMax M3 (ClinePass)", [0.5, 2.0, 0.1], 524_288, 512_000),
  model("cline-pass/qwen3.7-plus", "Qwen3.7 Plus (ClinePass)", [0.67, 2.68, 0.067], 1_000_000, 131_072),
  model("cline-pass/qwen3.7-max", "Qwen3.7 Max (ClinePass)", [4.17, 12.51, 0.83], 1_000_000, 131_072),
  model("cline-pass/qwen3.8-max", "Qwen3.8 Max (ClinePass)", [2.75, 8.25, 0.344], 1_000_000, 131_072),
];

export function modelIds(): string[] {
  return MODELS.map((m) => m.id);
}

/** True for the Cline free-tier models (cost 0). */
export function isFreeModel(id: string): boolean {
  return id.includes(":free") || id.includes("ox-alpha") || id === "deepseek/deepseek-v4-flash";
}
