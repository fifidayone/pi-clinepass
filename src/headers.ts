/**
 * Free-model request headers.
 *
 * The gateway gates Cline's free routes (":free" / cost-0 models) behind
 * "Cline product surfaces" (HTTP 403 without them). We identify as the Cline
 * CLI with a current version fetched from the npm registry, cached for 24h
 * with a bundled fallback. Every free-tier model goes through this gate, so
 * the identifying headers are applied to all of them via `isFreeModel`.
 */

import { release } from "node:os";
import { isFreeModel } from "./catalog.js";

const FALLBACK_CLINE_VERSION = "3.0.60";
const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NPM_REGISTRY_URL = "https://registry.npmjs.org/cline/latest";

/** Header-safe version shape (semver-ish tokens only): a malformed registry
 * response must never reach request headers, where control chars would make
 * undici throw and break the request. */
const VERSION_PATTERN = /^[\w.\-+]+$/;

let cachedVersion: string | undefined;
let cachedAt = 0;
let inflightVersion: Promise<string> | undefined;

export async function getClineVersion(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  if (cachedVersion && Date.now() - cachedAt < VERSION_CACHE_TTL_MS) return cachedVersion;
  // Deduplicate concurrent callers (e.g. session_start + a command racing).
  if (inflightVersion) return inflightVersion;
  inflightVersion = (async () => {
    try {
      const res = await fetchFn(NPM_REGISTRY_URL);
      if (res.ok) {
        const data = (await res.json()) as { version?: unknown };
        if (typeof data.version === "string" && VERSION_PATTERN.test(data.version)) {
          cachedVersion = data.version;
          cachedAt = Date.now();
          return cachedVersion;
        }
      }
    } catch {
      // fall through to bundled default
    }
    // Registry unreachable: use the bundled fallback but do not cache it
    // for the full TTL — the next session retries so a transient outage
    // doesn't pin an outdated version for a day.
    cachedVersion = FALLBACK_CLINE_VERSION;
    cachedAt = 0;
    return cachedVersion;
  })();
  try {
    return await inflightVersion;
  } finally {
    inflightVersion = undefined;
  }
}

/** Whether the given model id needs the Cline-CLI identifying headers (all
 * free-tier models do — the free route is gated to Cline product surfaces). */
export function needsFreeModelHeaders(modelId: string): boolean {
  return isFreeModel(modelId);
}

/**
 * Build the headers that make the free deepseek route servable.
 * Synchronous: uses the cached version (pre-warmed at startup or from a
 * previous request), falling back to the bundled default. Never fetches
 * inside a request path.
 */
export function buildFreeModelHeadersSync(): Record<string, string> {
  const version = cachedVersion ?? FALLBACK_CLINE_VERSION;
  return {
    "x-client-type": "cli",
    "x-client-version": version,
    "x-core-version": version,
    "x-platform": process.platform,
    "x-platform-version": release(),
    "user-agent": `Cline/${version}`,
  };
}
