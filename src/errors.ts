/**
 * ClinePass error classification — maps provider error text to friendly,
 * actionable messages surfaced through pi's UI.
 *
 * Classification order matters: the free-model route returns plain
 * `403 Forbidden` when its Cline-CLI header gate rejects us, which must not
 * be reported as a subscription problem, and free-limit errors may arrive
 * wrapped in a generic 403/429 shell.
 */

import { isFreeDeepSeekModel } from "./headers.js";

export type ClinePassErrorType =
  | "not_subscribed"
  | "auth_expired"
  | "rate_limited"
  | "free_limit_reached"
  | "free_route_forbidden"
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
    "Free model route unavailable (HTTP 403). The free DeepSeek route is gated to Cline product " +
    "surfaces — retry in a moment, or switch to a ClinePass model.",
  unknown: "ClinePass request failed. Check your subscription at app.cline.bot or run `pi /login`.",
};

/**
 * Classify a provider error string. `modelId` (the model of the failed
 * request, e.g. "deepseek/deepseek-v4-flash") disambiguates 403s on the
 * free route from subscription problems.
 */
export function classifyClinePassError(
  errorMessage: string,
  modelId?: string,
): {
  type: ClinePassErrorType;
  message: string;
} {
  const lower = errorMessage.toLowerCase();

  if (matchesAny(lower, ["401", "unauthorized", "invalid api key", "invalid_api_key"])) {
    return { type: "auth_expired", message: CLINEPASS_ERROR_MESSAGES.auth_expired };
  }
  if (matchesAny(lower, ["429", "rate limit", "too many requests", "rate_limit"])) {
    return { type: "rate_limited", message: CLINEPASS_ERROR_MESSAGES.rate_limited };
  }
  if (matchesAny(lower, ["free limit reached", "free limit", "try again in"])) {
    return { type: "free_limit_reached", message: CLINEPASS_ERROR_MESSAGES.free_limit_reached };
  }
  if (
    matchesAny(lower, [
      "403",
      "forbidden",
      "subscription required",
      "not subscribed",
      "organization accounts cannot use",
    ])
  ) {
    if (modelId && isFreeDeepSeekModel(modelId)) {
      return { type: "free_route_forbidden", message: CLINEPASS_ERROR_MESSAGES.free_route_forbidden };
    }
    return { type: "not_subscribed", message: CLINEPASS_ERROR_MESSAGES.not_subscribed };
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
