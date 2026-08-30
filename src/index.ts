/**
 * pi-clinepass — ClinePass for pi.
 *
 * Registers the `clinepass` provider (14 paid models with measured billing
 * prices + 4 free models) and wires the hooks that keep pi's numbers real:
 *   - message_end → server-truth cost meter + session total + error surface + thinking repair
 *   - before_provider_headers → free-route Cline-CLI headers
 *   - model_select / session_start → immediate meter + default model sync
 *   - /clinepass → dashboard report · price calibration (full-screen view)
 *
 * Model prices come from the static catalog unless the user has run
 * calibration (`/clinepass → Calibrate`), which measures the gateway's real
 * billing rates and persists them to ~/.pi/agent/clinepass-prices.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isFreeModel, MODELS } from "./catalog.js";
import { DEFAULT_API_BASE, WORKOS_TOKEN_PREFIX } from "./workos.js";
import { getApiKey, login, refreshToken, resolvePiStoredCredential } from "./auth.js";
import {
  getCapReport,
  getCapReportData,
  handleInitialMeter,
  handleUsageTracking,
  PROVIDER_NAME,
  reseedUsageBaseline,
  setUsageTrackingPaused,
} from "./usage.js";
import { buildFreeModelHeadersSync, getClineVersion, needsFreeModelHeaders } from "./headers.js";
import { handleClinePassError } from "./errors.js";
import { normalizeThinking } from "./thinking.js";
import { savePiDefaultModel } from "./settings.js";
import {
  buildCalibrationFile,
  formatCalibrationReport,
  runCalibration,
  type CalibrationRunResult,
} from "./calibrate.js";
import { CalibrationView, ReportView, type ViewTheme } from "./views.js";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  currentCalibration,
  displayName,
  getEffectiveModels,
  refreshEffectiveModels,
  writeCalibrationFile,
} from "./pricing.js";

/** Guard so a second /clinepass invocation cannot double-run calibration. */
let calibrationRunning = false;

// Menu labels embed a description (pi's select only takes plain strings — the
// em-dash separator is the standard pattern for string-option menus).
const MENU_DASHBOARD = "View price dashboard — model rates and plan limits";
const MENU_CALIBRATE = "Calibrate model prices — measure real gateway billing";

/** Current effective models, priced and named for the picker. */
function providerModels() {
  // Estimator layer OFF: cost is zeroed so pi's own cost displays stay out of
  // the picture — the /usages meter is the single cost display. Picker prices
  // come from the store via displayName.
  return getEffectiveModels().map((model) => ({
    ...model,
    input: [...model.input],
    name: displayName(model),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
}

/** Full provider config — reusable so a post-calibration re-register stays in
 * sync with the factory registration (pi applies it immediately). */
function providerConfig() {
  return {
    name: "ClinePass",
    baseUrl: `${DEFAULT_API_BASE}/api/v1`,
    authHeader: true,
    // ClinePass is OpenAI-compatible; pi's built-in openai-completions
    // streaming handles SSE, tools, and usage. No custom streamSimple.
    api: "openai-completions" as const,
    oauth: {
      name: "ClinePass",
      isSubscription: true,
      login,
      refreshToken,
      getApiKey,
    },
    // Calibrated overrides (when present) merged over the static catalog; the
    // picker shows name + effective price (or "(free)").
    models: providerModels(),
    // pi pulls this on model refresh — always the current effective prices.
    refreshModels: async () => providerModels(),
  };
}

export default async function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_NAME, providerConfig());

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
    // Repair gateway-side reasoning-stream corruption before persistence:
    // a token-joined thinking block would otherwise be replayed into the
    // request context and re-billed as inflated input tokens on every
    // subsequent turn of the session.
    const repaired = normalizeThinking(event, ctx);
    // Billing tracking is queued in the background: message_end handlers
    // are awaited inline by pi and gate message finalization + the agent
    // loop, so polling the usage API (with its server flush delay) must
    // never run on this path.
    void handleUsageTracking(event, ctx, writeCostEntry);
    // pi persists the returned message when a repair happened (role kept).
    return repaired;
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
    description: "ClinePass dashboard, price calibration, and plan limits",
    handler: async (_args, ctx) => {
      const hasUi = ctx.hasUI && !!ctx.ui?.notify && !!ctx.ui?.select && !!ctx.ui?.confirm;
      if (!hasUi) {
        // Headless: print the report; calibration and its confirm dialog
        // need the TUI.
        const report = await getCapReport();
        console.log(`\n${report}\n`);
        return;
      }

      const ui = ctx.ui as CalibrateUi;
      // Pre-flight: without a ClinePass subscription the dashboard and
      // calibration are both dead ends — say so before the picker instead of
      // after it. The same fetch feeds the dashboard, so no extra request.
      const data = await getCapReportData();
      if (typeof data === "string") {
        ui.notify(data, "warning");
        return;
      }

      const choice = await ctx.ui.select("ClinePass", [MENU_DASHBOARD, MENU_CALIBRATE]);
      if (choice === MENU_CALIBRATE) {
        await runCalibrationFlow(pi, ctx);
      } else if (choice === MENU_DASHBOARD) {
        // Same bordered modal as calibration: prices left (scroll), plan
        // sidebar right; narrow terminals fall back to a stacked layout.
        await ui.custom<void>(
          (tui, theme, _kb, done) => new ReportView(tui, theme, data, () => done(void 0)),
          // No fixed width: pi sizes the overlay from the view's `width`, so
          // the box hugs its content and floats centered on the terminal.
          { overlay: true, onHandle: (handle) => handle.focus() },
        );
      }
    },
  });
}

interface CalibrateUi {
  notify: (msg: string, type: "info" | "warning" | "error") => void;
  confirm: (title: string, message: string) => Promise<boolean>;
  custom: <T>(
    factory: (
      tui: TUI,
      theme: ViewTheme,
      keybindings: unknown,
      done: (value: T) => void,
    ) => Component & { dispose?(): void },
    options?: {
      overlay?: boolean;
      overlayOptions?: { anchor?: string; width?: number | string; maxHeight?: number | string };
      onHandle?: (handle: { focus(): void; unfocus(options?: unknown): void }) => void;
    },
  ) => Promise<T>;
}

/**
 * Interactive price calibration: estimate → user confirmation (with real
 * quota %) → probes with the meter paused → persist + report. Never blocks
 * mid-work: the user starts it explicitly from the /clinepass menu.
 */
async function runCalibrationFlow(pi: ExtensionAPI, ctx: { ui?: unknown }): Promise<void> {
  const ui = ctx.ui as CalibrateUi;
  const paid = getEffectiveModels().filter((m) => !isFreeModel(m.id));
  if (paid.length === 0) {
    ui.notify("No paid ClinePass models found.", "error");
    return;
  }
  if (!resolvePiStoredCredential()) {
    ui.notify("ClinePass login required — run /login first.", "error");
    return;
  }
  if (calibrationRunning) {
    ui.notify("Calibration is already running.", "warning");
    return;
  }
  calibrationRunning = true;
  try {
    const ok = await ui.confirm(
      "Calibrate model prices?",
      "This will use approximately 5-10% of your 5-hour quota.\n\nContinue?",
    );
    if (!ok) return;

    setUsageTrackingPaused(true);
    const abort = new AbortController();
    // Holder object — TS narrows plain `let` assigned inside callbacks to null.
    const box: { result: CalibrationRunResult | null; error?: string } = { result: null };
    try {
      // Centered modal: floats on top of the transcript, row window fits the
      // terminal, cancel hint lives inside the box — never clipped.
      await ui.custom<void>(
        (tui, theme, _kb, done) => {
          const view = new CalibrationView(tui, theme, {
            onCancel: () => abort.abort(),
            onClose: () => done(void 0),
          });
          runCalibration(paid, {
            signal: abort.signal,
            onProgress: (p) => view.update(p),
          })
            .then((r) => {
              box.result = r;
              view.finish(summarizeRun(r, abort.signal.aborted));
            })
            .catch((err) => {
              box.error = err instanceof Error ? err.message : String(err);
              view.finish(`calibration failed: ${box.error}`, true);
            });
          return view;
        },
        {
          overlay: true,
          // No fixed width: the box hugs its content (see ReportView above).
          onHandle: (handle) => handle.focus(),
        },
      );
    } finally {
      setUsageTrackingPaused(false);
      // Probe spend must never be adopted by later turns' meter tracking.
      void reseedUsageBaseline().catch(() => {});
    }

    if (!box.result) {
      ui.notify(`Calibration failed: ${box.error ?? "no results"}`, "error");
      return;
    }
    const result = box.result;

    if (result.applied && result.results.some((r) => r.after)) {
      // Merge over the existing store: measured models update, anything the
      // run could not measure keeps its previous store value — the panel
      // never has gaps. The release stamp carries over so the calibration
      // survives the next session's version check.
      const previous = currentCalibration();
      const file = buildCalibrationFile(result, new Date().toISOString(), previous?.catalogVersion);
      if (previous) {
        for (const [id, entry] of Object.entries(previous.models)) {
          if (!file.models[id]) file.models[id] = entry;
        }
      }
      writeCalibrationFile(file);
      refreshEffectiveModels();
      // Re-register so the picker shows the new prices immediately —
      // post-factory registerProvider takes effect without a /reload.
      pi.registerProvider(PROVIDER_NAME, providerConfig());
    }
    ui.notify(formatCalibrationReport(result, abort.signal.aborted), result.applied ? "info" : "warning");
  } finally {
    calibrationRunning = false;
  }
}

/** One-line summary for the view's final screen. */
function summarizeRun(result: CalibrationRunResult, cancelled: boolean): string {
  const applied = result.results.filter((r) => r.status === "applied").length;
  const unchanged = result.results.filter((r) => r.status === "unchanged").length;
  const failed = result.results.filter((r) => r.status === "failed").length;
  const parts = [
    `${applied} repriced`,
    `${unchanged} unchanged`,
    `${failed} failed`,
    `$${result.spentUsd.toFixed(4)} spent`,
  ];
  return `${cancelled ? "cancelled — " : ""}${parts.join(" · ")}`;
}

export { MODELS, PROVIDER_NAME, WORKOS_TOKEN_PREFIX };
