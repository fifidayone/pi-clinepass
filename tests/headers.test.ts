import { describe, expect, it, vi } from "vitest";
import { buildFreeModelHeadersSync, getClineVersion } from "../src/headers.js";

/** Bundled fallback in src/headers.ts (not exported) — used when the registry
 * response is unusable. */
const FALLBACK_VERSION = "3.0.65";

const JSON_RESPONSE = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("getClineVersion", () => {
  it("rejects a registry version carrying control characters and uses the fallback", async () => {
    const fetchFn = vi.fn().mockResolvedValue(JSON_RESPONSE({ version: "3.0.9\r\nX-Evil: 1" }));
    await expect(getClineVersion(fetchFn)).resolves.toBe(FALLBACK_VERSION);
  });

  it("rejects versions with characters that are not header-safe", async () => {
    const fetchFn = vi.fn().mockResolvedValue(JSON_RESPONSE({ version: "3.0.9 beta\u0000" }));
    await expect(getClineVersion(fetchFn)).resolves.toBe(FALLBACK_VERSION);
  });

  it("recovers on the next call (a malformed version is never cached for the TTL)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(JSON_RESPONSE({ version: "9.9.9" }));
    await expect(getClineVersion(fetchFn)).resolves.toBe("9.9.9");
    // Valid version is cached: the second call must not refetch.
    await expect(getClineVersion(fetchFn)).resolves.toBe("9.9.9");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("buildFreeModelHeadersSync", () => {
  it("builds the exact headers matching Cline CLI 3.0.65 convention", () => {
    const headers = buildFreeModelHeadersSync();
    expect(headers["HTTP-Referer"]).toBe("https://cline.bot");
    expect(headers["X-Title"]).toBe("Cline");
    expect(headers["X-IS-MULTIROOT"]).toBe("false");
    expect(headers["X-CLIENT-TYPE"]).toBe("cline-cli");
    expect(headers["X-CLIENT-VERSION"]).toBeDefined();
    expect(headers["X-CORE-VERSION"]).toBeDefined();
    expect(headers["X-PLATFORM"]).toBe(process.platform);
    expect(headers["User-Agent"]).toContain("Cline/");
  });
});
