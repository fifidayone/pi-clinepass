/**
 * ClinePass error classification — maps provider error text to friendly,
 * actionable messages surfaced through pi's UI.
 *
 * Classification order matters: the free-model routes return plain
 * `403 Forbidden` when their Cline-CLI header gate rejects us, which must not
 * be reported as a subscription problem, and free-limit errors may arrive
 * wrapped in a generic 403/429 shell.
 */

import { isFreeModel } from "./catalog.js";

export type ClinePassErrorType =
  | "not_subscribed"
  | "auth_expired"
  | "rate_limited"
  | "free_limit_reached"
  | "free_route_forbidden"
  | "insufficient_credits"
  | "model_not_found"
  | "upstream_error"
  | "server_error"
  | "unknown";

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some((p) => text.includes(p));
}

export const CLINEPASS_ERROR_MESSAGES: Record<ClinePassErrorType, string> = {
  not_subscribed:
    "ClinePass subscription required — or the organization account cannot use ClinePass. " +
    "Visit app.cline.bot to subscribe / switch to your personal account, or run `pi /login`.",
  auth_expired:
    "ClinePass authentication expired. Run `pi /login` and select ClinePass to refresh credentials.",
  rate_limited:
    "ClinePass rate limit reached. Wait a moment and try again, or check your plan at app.cline.bot.",
  free_limit_reached:
    "Free model rate limit reached. Please wait a few moments and try again.",
  free_route_forbidden:
    "Free model route unavailable (HTTP 403). The free route is gated to Cline product " +
    "surfaces — retry in a moment, or switch to a ClinePass model.",
  insufficient_credits:
    "Insufficient Cline credits. Top up your balance at app.cline.bot/credits or switch to a free/subscription model.",
  model_not_found:
    "Model not found on Cline gateway (HTTP 404). Run `/model` to select an available model.",
  upstream_error:
    "Upstream model provider error. The model host returned an error — retry in a moment, or switch to another model.",
  server_error:
    "Cline gateway server error. The service is temporarily unavailable — please retry in a moment.",
  unknown: "ClinePass request failed. Please check app.cline.bot or try again later.",
};

/**
 * Classify a provider error string. `modelId` (the model of the failed
 * request, e.g. "deepseek/deepseek-v4-flash") disambiguates 403s on free
 * routes from subscription problems.
 */
export function classifyClinePassError(
  errorMessage: string,
  modelId?: string,
): {
  type: ClinePassErrorType;
  message: string;
} {
  const lower = errorMessage.toLowerCase();

  // 1. Upstream Provider / Inference host errors:
  // Must precede auth checks because upstream errors (e.g. OpenRouter/Meta/DeepSeek)
  // often forward payloads containing "401" or "invalid_api_key" from the host,
  // which does not mean the user's ClinePass authentication has expired.
  if (
    matchesAny(lower, [
      "provider returned error",
      "failed to generate stream from openrouter",
      "openrouter",
      "inference request failed",
      "failed to invoke model",
      "provider_error_code",
    ])
  ) {
    return { type: "upstream_error", message: CLINEPASS_ERROR_MESSAGES.upstream_error };
  }

  // 2. Insufficient Credits (HTTP 402)
  if (matchesAny(lower, ["insufficient_credits", "insufficient balance", "buy_credits_url", "402"])) {
    return { type: "insufficient_credits", message: CLINEPASS_ERROR_MESSAGES.insufficient_credits };
  }

  // 3. Model Not Found (HTTP 404)
  if (matchesAny(lower, ["model not found", "model_not_found"]) || /\b404\b/.test(lower)) {
    return { type: "model_not_found", message: CLINEPASS_ERROR_MESSAGES.model_not_found };
  }

  // 4. Rate Limits & Free limits
  if (matchesAny(lower, ["free limit reached", "free limit", "try again in"])) {
    return { type: "free_limit_reached", message: CLINEPASS_ERROR_MESSAGES.free_limit_reached };
  }
  if (matchesAny(lower, ["rate limit", "too many requests", "rate_limit"]) || /\b429\b/.test(lower)) {
    return { type: "rate_limited", message: CLINEPASS_ERROR_MESSAGES.rate_limited };
  }

  // 5. Subscription & Route Access (HTTP 403)
  if (
    matchesAny(lower, [
      "subscription required",
      "not subscribed",
      "organization accounts cannot use",
      "forbidden",
    ]) ||
    /\b403\b/.test(lower)
  ) {
    // Every free-tier route is gated to Cline product surfaces — a 403 on a
    // free model is a route-gate rejection, not a subscription problem.
    if (modelId && isFreeModel(modelId)) {
      return { type: "free_route_forbidden", message: CLINEPASS_ERROR_MESSAGES.free_route_forbidden };
    }
    return { type: "not_subscribed", message: CLINEPASS_ERROR_MESSAGES.not_subscribed };
  }

  // 6. Gateway / Server 5xx Errors
  if (
    matchesAny(lower, [
      "bad gateway",
      "service unavailable",
      "gateway timeout",
      "internal server error",
    ]) ||
    /\b(500|502|503|504)\b/.test(lower)
  ) {
    return { type: "server_error", message: CLINEPASS_ERROR_MESSAGES.server_error };
  }

  // 7. Client Authentication (genuine 401 / unauthorized from Cline gateway)
  if (
    matchesAny(lower, ["unauthorized", "invalid api key", "invalid_api_key"]) ||
    /\b401\b/.test(lower)
  ) {
    return { type: "auth_expired", message: CLINEPASS_ERROR_MESSAGES.auth_expired };
  }

  return { type: "unknown", message: CLINEPASS_ERROR_MESSAGES.unknown };
}

export interface ErrorContext {
  hasUI: boolean;
  ui: {
    notify: (msg: string, type: "info" | "warning" | "error") => void;
  };
  model?: { provider?: string };
}

/** Handle a message_end event: classify ClinePass errors and notify. */
export function handleClinePassError(
  event: { message: unknown },
  ctx: ErrorContext,
): void {
  if (!event.message) return;
  const msg = event.message as {
    stopReason?: string;
    errorMessage?: string;
    provider?: string;
    model?: string;
  };
  if (msg.stopReason !== "error" || !msg.errorMessage) return;

  const provider = msg.provider ?? ctx.model?.provider;
  if (provider !== "clinepass" && provider !== "cline-pass") return;

  const { message: friendly } = classifyClinePassError(msg.errorMessage, msg.model);
  if (ctx.hasUI) {
    ctx.ui.notify(friendly, "error");
  } else {
    console.error(`[pi-clinepass] ${friendly}`);
  }
}
