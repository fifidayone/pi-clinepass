import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptUsageRecord,
  fetchPlanLimits,
  fetchUsageRecords,
  getActiveToken,
  handleUsageTracking,
  resetUsageTrackingForTest,
  sumSessionEntries,
  type UsageRecord,
} from "../src/usage.js";

const JSON_RESPONSE = (data: unknown, ok = true): Response =>
  new Response(JSON.stringify({ data, success: ok }), {
    status: ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });

const API_BASE = "https://api.cline.bot";
const AUTH_JSON = "/home/test/.pi/agent/auth.json";
const PROVIDERS_JSON = "/home/test/.cline/data/settings/providers.json";

const future = (): number => Date.now() + 999_999;

function oauthFixture(access = "workos:t"): string {
  return JSON.stringify({ clinepass: { type: "oauth", access, refresh: "rt", expires: future() } });
}

/** Normalize Windows path separators so fixtures can use forward slashes. */
const norm = (p: string): string => p.replace(/\\/g, "/");

/** Injectable filesystem + fetch options for auth/usage resolution. */
function makeFilesystem(files: Record<string, string>, fetchFn?: typeof fetch) {
  return {
    apiBase: API_BASE,
    fetch: fetchFn ?? vi.fn().mockResolvedValue(JSON_RESPONSE({})),
    homeDir: () => "/home/test",
    readFile: (p: string) => {
      const content = files[norm(p)];
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      return content;
    },
    fileExists: (p: string) => Object.prototype.hasOwnProperty.call(files, norm(p)),
  };
}

beforeEach(() => {
  resetUsageTrackingForTest();
});

describe("usage", () => {
  it("parses usage records and converts micro-USD to USD", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/users/me")) return JSON_RESPONSE({ id: "usr-1" });
      if (u.includes("/usages")) {
        return JSON_RESPONSE({
          items: [
            {
              id: "usg-1",
              aiModelName: "cline-pass/kimi-k3",
              promptTokens: 1000,
              cachedTokens: 800,
              completionTokens: 200,
              costUsd: 60_000_000, // $0.60
            },
          ],
        });
      }
      return JSON_RESPONSE({});
    });
    const records = await fetchUsageRecords(makeFilesystem({ [AUTH_JSON]: oauthFixture() }, fetchFn));
    expect(records).toHaveLength(1);
    expect(records?.[0].costUsd).toBeCloseTo(0.6);
    expect(records?.[0].cachedTokens).toBe(800);
    expect(records?.[0].totalTokens).toBe(1200);
  });

  it("reads cap thresholds from plan entitlements (micro-USD)", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/usage-limits")) {
        return JSON_RESPONSE({
          limits: [
            { type: "five_hour", percentUsed: 20, resetsAt: "2026-08-25T09:00:00Z" },
            { type: "weekly", percentUsed: 50 },
            { type: "monthly", percentUsed: 80 },
          ],
        });
      }
      if (u.includes("/plan")) {
        return JSON_RESPONSE({
          plan: {
            displayName: "Cline Pass (Monthly)",
            isActive: true,
            entitlements: {
              cline_pass: {
                inferenceCapThreshold: {
                  last5HoursUsageCostUSDPerUser: 1_000_000_000,
                  last7daysUsageCostUSDPerUser: 2_500_000_000,
                  last30daysUsageCostUSDPerUser: 5_000_000_000,
                },
              },
            },
          },
        });
      }
      return JSON_RESPONSE({});
    });
    const limits = await fetchPlanLimits(makeFilesystem({ [AUTH_JSON]: oauthFixture() }, fetchFn));
    expect(limits?.fiveHour).toMatchObject({ usedPercent: 20, limitUsd: 10 });
    expect(limits?.sevenDay.limitUsd).toBe(25);
    expect(limits?.thirtyDay.limitUsd).toBe(50);
    expect(limits?.planName).toBe("Cline Pass (Monthly)");
  });

  it("reports undefined limits when the plan exposes no cap entitlements", async () => {
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/usage-limits")) {
        return JSON_RESPONSE({ limits: [{ type: "five_hour", percentUsed: 10 }] });
      }
      if (u.includes("/plan")) return JSON_RESPONSE({ plan: { displayName: "Cline Pass" } });
      return JSON_RESPONSE({});
    });
    const limits = await fetchPlanLimits(makeFilesystem({ [AUTH_JSON]: oauthFixture() }, fetchFn));
    expect(limits?.fiveHour.limitUsd).toBeUndefined();
    expect(limits?.fiveHour.usedPercent).toBe(10);
  });
});

describe("getActiveToken priority", () => {
  it("uses pi's stored credential (the /login identity)", async () => {
    const options = makeFilesystem({
      [AUTH_JSON]: oauthFixture("workos:pi"),
    });
    await expect(getActiveToken(options)).resolves.toBe("workos:pi");
  });

  it("has no ambient sources: a Cline CLI login never authenticates before /login", async () => {
    // Machine has a Cline CLI login (and env could be set) but the user has
    // never logged in to the provider in pi — nothing may be picked up.
    const options = makeFilesystem({
      [PROVIDERS_JSON]: JSON.stringify({
        providers: {
          "cline-pass": { settings: { auth: { accessToken: "workos:cli", refreshToken: "cli-rt", expiresAt: future() } } },
        },
      }),
    });
    await expect(getActiveToken(options)).resolves.toBeUndefined();
  });

  it("logout drops the cached token with no ambient fallback", async () => {
    // /logout deletes auth.json#clinepass. Even with a Cline CLI login still
    // on the machine, the meter must stop immediately, not switch accounts.
    const files: Record<string, string> = {
      [AUTH_JSON]: oauthFixture("workos:pi"),
      [PROVIDERS_JSON]: JSON.stringify({
        providers: {
          "cline-pass": { settings: { auth: { accessToken: "workos:cli", refreshToken: "cli-rt", expiresAt: future() } } },
        },
      }),
    };
    const options = makeFilesystem(files);
    await expect(getActiveToken(options)).resolves.toBe("workos:pi");
    delete files[AUTH_JSON];
    await expect(getActiveToken(options)).resolves.toBeUndefined();
  });

  it("caches the refreshed token: no second network refresh while valid", async () => {
    // Near-expiry WorkOS credential; persist is a no-op so the store keeps
    // the stale credential — only the cache can suppress repeat refreshes.
    const files: Record<string, string> = {
      [AUTH_JSON]: JSON.stringify({
        clinepass: { type: "oauth", access: "workos:t", refresh: "rt", expires: Date.now() + 1000 },
      }),
    };
    const refreshCalls: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      refreshCalls.push(String(url));
      return new Response(JSON.stringify({ data: { accessToken: "workos:new", refreshToken: "rt2" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const options = {
      ...makeFilesystem(files, fetchFn),
      writeFile: () => {},
    };
    await expect(getActiveToken(options)).resolves.toBe("workos:new");
    await expect(getActiveToken(options)).resolves.toBe("workos:new");
    expect(refreshCalls.filter((u) => u.includes("/auth/refresh"))).toHaveLength(1);
  });

  it("drops the cached token when no credential remains after logout", async () => {
    const files: Record<string, string> = { [AUTH_JSON]: oauthFixture("workos:pi") };
    const options = makeFilesystem(files);
    await expect(getActiveToken(options)).resolves.toBe("workos:pi");
    delete files[AUTH_JSON];
    await expect(getActiveToken(options)).resolves.toBeUndefined();
  });

  it("switches accounts immediately when the stored credential changes", async () => {
    // Logout + login as another account (e.g. pasted key) mid-session.
    const files: Record<string, string> = { [AUTH_JSON]: oauthFixture("workos:a") };
    const options = makeFilesystem(files);
    await expect(getActiveToken(options)).resolves.toBe("workos:a");
    files[AUTH_JSON] = oauthFixture("workos:b");
    await expect(getActiveToken(options)).resolves.toBe("workos:b");
  });
});

describe("handleUsageTracking logout behavior", () => {
  it("stops billing traffic and writes no entry when logged out before the turn ends", async () => {
    const files: Record<string, string> = { [AUTH_JSON]: oauthFixture() };
    const apiCalls: string[] = [];
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      apiCalls.push(String(url));
      if (String(url).includes("/users/me")) return JSON_RESPONSE({ id: "usr-1" });
      return JSON_RESPONSE({ items: [] });
    });
    const options = makeFilesystem(files, fetchFn);
    const entries: unknown[] = [];
    const ctx = {
      model: { provider: "clinepass", id: "cline-pass/kimi-k3" },
      ui: { setStatus: vi.fn() },
    };

    // Turn finishes, tracking queued… then the user logs out before the
    // poll interval elapses.
    const tracked = handleUsageTracking(
      { message: { role: "assistant", provider: "clinepass", model: "cline-pass/kimi-k3" } },
      ctx,
      (u) => entries.push(u),
      options,
    );
    delete files[AUTH_JSON];
    await tracked;

    expect(entries).toHaveLength(0);
    expect(apiCalls).toHaveLength(0); // no /users/me, no /usages — nothing fired
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("clinepass-cost", undefined); // meter cleared
  });

  it("stops mid-poll when the user logs out during the flush window", async () => {
    const files: Record<string, string> = { [AUTH_JSON]: oauthFixture() };
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/users/me")) return JSON_RESPONSE({ id: "usr-1" });
      return JSON_RESPONSE({
        items: [
          {
            id: "usg-1",
            aiModelName: "cline-pass/kimi-k3",
            promptTokens: 10,
            cachedTokens: 0,
            completionTokens: 5,
            costUsd: 1_000_000,
            createdAt: new Date().toISOString(),
          },
        ],
      });
    });
    const options = makeFilesystem(files, fetchFn);
    const entries: unknown[] = [];
    const ctx = {
      model: { provider: "clinepass", id: "cline-pass/kimi-k3" },
      ui: { setStatus: vi.fn() },
    };

    const tracked = handleUsageTracking(
      { message: { role: "assistant", provider: "clinepass", model: "cline-pass/kimi-k3" } },
      ctx,
      (u) => entries.push(u),
      options,
    );
    // Logout lands during the first sleep(400) — the poll must bail without
    // adopting or writing anything, and the meter must be cleared.
    setTimeout(() => delete files[AUTH_JSON], 100);
    await tracked;

    expect(entries).toHaveLength(0);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("clinepass-cost", undefined);
  });
});

describe("adoptUsageRecord", () => {
  const rec = (id: string, model: string, ageMs: number): UsageRecord => ({
    id,
    model,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0.1,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
  });

  it("skips stale records from before the turn started", () => {
    const stale = [rec("usg-old", "cline-pass/kimi-k3", 10 * 60_000)];
    expect(adoptUsageRecord(stale, Date.now(), "cline-pass/kimi-k3")).toBeUndefined();
  });

  it("parses real paid usage: aiModelName is the catalog id, raw_model is vendor path", async () => {
    // Real /usages for a paid model: aiModelName = catalog id,
    // metadata.raw_model = upstream vendor path. The parser must keep
    // aiModelName (not raw_model) so the meter can match the message.
    const fetchFn = vi.fn().mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/users/me")) return JSON_RESPONSE({ id: "usr-1" });
      if (u.includes("/usages")) {
        return JSON_RESPONSE({
          items: [
            {
              id: "usg-1",
              aiModelName: "cline-pass/mimo-v2.5-pro",
              metadata: { raw_model: "xiaomi/mimo-v2.5-pro" },
              promptTokens: 10,
              cachedTokens: 0,
              completionTokens: 5,
              costUsd: 119233,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
      return JSON_RESPONSE({});
    });
    const records = await fetchUsageRecords(makeFilesystem({ [AUTH_JSON]: oauthFixture() }, fetchFn));
    expect(records?.[0].model).toBe("cline-pass/mimo-v2.5-pro");
    expect(records?.[0].costUsd).toBeCloseTo(0.00119233);
    const adopted = adoptUsageRecord(records ?? [], Date.now(), "cline-pass/mimo-v2.5-pro");
    expect(adopted?.id).toBe("usg-1");
  });

  it("skips fresh records billed for a different model", () => {
    const foreign = [rec("usg-x", "cline-pass/glm-5.3", 5_000)];
    expect(adoptUsageRecord(foreign, Date.now(), "cline-pass/kimi-k3")).toBeUndefined();
  });

  it("adopts the newest unseen record matching model and freshness", () => {
    const records = [
      rec("usg-x", "cline-pass/glm-5.3", 5_000),
      rec("usg-ok", "cline-pass/kimi-k3", 6_000),
    ];
    expect(adoptUsageRecord(records, Date.now(), "cline-pass/kimi-k3")?.id).toBe("usg-ok");
    // Already-adopted record is never re-adopted (no double counting).
    expect(adoptUsageRecord([rec("usg-ok", "cline-pass/kimi-k3", 6_000)], Date.now(), "cline-pass/kimi-k3")).toBeUndefined();
  });
});

describe("sumSessionEntries", () => {
  const entry = (id: string, parentId: string | null, costUsd?: number) => ({
    type: "custom",
    customType: costUsd === undefined ? "other-kind" : "clinepass-cost",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    ...(costUsd === undefined ? { data: {} } : { data: { costUsd } }),
  });

  it("counts all real spend, including turns abandoned by rewind/fork", () => {
    // Matches pi's billing philosophy (getSessionStats): abandoned-branch
    // API calls were really billed, so they count toward the session total.
    const sessionManager = {
      getEntries: () => [
        entry("e1", null),
        entry("e2", "e1", 0.5),
        entry("e3", "e2", 0.7),
        entry("e-abandoned", "e1", 9),
      ],
    };
    expect(sumSessionEntries(sessionManager)).toBeCloseTo(10.2);
  });

  it("falls back to zero when no entries are available", () => {
    expect(sumSessionEntries(undefined)).toBe(0);
  });
});
