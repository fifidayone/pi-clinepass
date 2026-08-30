/**
 * Persist the selected model as pi's global default (settings.json).
 *
 * pi keeps model selection session-scoped; syncing it here means new
 * sessions start with the model actually used. Best-effort: never throws.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PI_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
/** pi's settings-manager holds this while writing settings.json. */
const LOCK_PATH = `${PI_SETTINGS_PATH}.lock`;

export async function savePiDefaultModel(provider: string, modelId: string): Promise<void> {
  try {
    if (!existsSync(PI_SETTINGS_PATH)) return;
    // Two passes: pi's settings-manager holds `<path>.lock` while writing. If
    // it rewrites settings.json between our read and our write (a settings
    // change landing at the same moment), our first write would silently
    // overwrite its update — wait for the lock, re-read, and redo the merge
    // once. The second pass returns immediately when our values are already
    // in place.
    for (let pass = 0; pass < 2; pass++) {
      for (let attempt = 0; attempt < 5 && existsSync(LOCK_PATH); attempt++) {
        await sleep(100);
      }
      const settings = JSON.parse(readFileSync(PI_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
      if (settings.defaultProvider === provider && settings.defaultModel === modelId) return;
      settings.defaultProvider = provider;
      settings.defaultModel = modelId;
      atomicWrite(PI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.warn(
      `[pi-clinepass] failed to save default model: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, "utf8");
  // rename replaces atomically on POSIX; on Windows it may fail if the
  // target is open — fall back to direct write in that case.
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, data, "utf8");
  }
}
