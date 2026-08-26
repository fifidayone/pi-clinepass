/**
 * pi-clinepass — ClinePass provider for pi.
 *
 * Registers the `clinepass` provider (13 paid models with measured billing
 * prices + 3 free models) and wires the hooks that keep pi's numbers real:
 *   - message_end → server-truth cost meter + session total + error surface
 *   - before_provider_headers → free deepseek route headers
 *   - model_select / session_start → immediate meter + default model sync
 *   - /clinepass → price table + plan limit report
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODELS } from "./catalog.js";
import { DEFAULT_API_BASE, WORKOS_TOKEN_PREFIX } from "./workos.js";
import { getApiKey, login, refreshToken } from "./auth.js";
import {
  getCapReport,
  handleInitialMeter,
  handleUsageTracking,
  PROVIDER_NAME,
} from "./usage.js";
import { buildFreeModelHeadersSync, getClineVersion, needsFreeModelHeaders } from "./headers.js";
import { handleClinePassError } from "./errors.js";
import { savePiDefaultModel } from "./settings.js";

export default async function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_NAME, {
    name: "ClinePass",
    baseUrl: `${DEFAULT_API_BASE}/api/v1`,
    authHeader: true,
    // ClinePass is OpenAI-compatible; pi's built-in openai-completions
    // streaming handles SSE, tools, and usage. No custom streamSimple.
    api: "openai-completions",
    oauth: {
      name: "ClinePass",
      isSubscription: true,
      login,
      refreshToken,
      getApiKey,
    },
    models: MODELS.map((model) => ({
      ...model,
      input: [...model.input],
    })),
  });

  // Persist the per-turn server bill as a custom session entry so the
  // session total survives resume/fork, then surface it in the status meter.
  const writeCostEntry = (usage: { id: string; costUsd: number; model: string }): void => {
    pi.appendEntry("clinepass-cost", {
      usageId: usage.id,
      costUsd: usage.costUsd,
      model: usage.model,
    });
  };

  pi.on("message_end", (event, ctx) => {
    handleClinePassError(event, ctx);
    // Billing tracking is queued in the background: message_end handlers
    // are awaited inline by pi and gate message finalization + the agent
    // loop, so polling the usage API (with its server flush delay) must
    // never run on this path.
    void handleUsageTracking(event, ctx, writeCostEntry);
  });

  // The free deepseek route requires Cline-CLI identifying headers. The
  // version is pre-warmed at session_start (the factory must stay
  // network-free) so the sync handler never fetches.
  pi.on("before_provider_headers", (event, ctx) => {
    const modelId = ctx.model?.id ?? "";
    if (!needsFreeModelHeaders(modelId)) return;
    Object.assign(event.headers, buildFreeModelHeadersSync());
  });

  pi.on("model_select", (event, ctx) => {
    const { provider, id } = event.model;
    const modelId = id.startsWith(`${provider}/`) ? id.slice(provider.length + 1) : id;
    // Persist the global default only for explicit selections of our models:
    // model cycling (Ctrl+P) and old-session restores must not rewrite the
    // user's global default, and other providers manage their own settings.
    if (event.source === "set" && (provider === PROVIDER_NAME || provider === "cline-pass")) {
      void savePiDefaultModel(provider, modelId);
    }
    void handleInitialMeter(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    // Pre-warm the Cline CLI version here instead of the factory: the
    // factory runs for every invocation (including --list-models). The
    // sync header builder falls back to the bundled version until this
    // fetch completes.
    void getClineVersion().catch(() => {});
    void handleInitialMeter(ctx);
  });

  pi.registerCommand("clinepass", {
    description: "Show ClinePass model rates and plan limit utilization",
    handler: async (_args, ctx) => {
      const report = await getCapReport();
      if (ctx.hasUI && ctx.ui.notify) {
        ctx.ui.notify(report, "info");
      } else {
        console.log(`\n${report}\n`);
      }
    },
  });
}

export { MODELS, PROVIDER_NAME, WORKOS_TOKEN_PREFIX };
