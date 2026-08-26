import { describe, expect, it, vi } from "vitest";
import {
  ensureWorkosPrefix,
  isWorkosToken,
  pollDeviceAuthorization,
  refreshWorkosToken,
} from "../src/workos.js";

describe("workos", () => {
  it("detects and ensures the workos: prefix", () => {
    expect(isWorkosToken("workos:eyJ")).toBe(true);
    expect(isWorkosToken("eyJ")).toBe(false);
    expect(ensureWorkosPrefix("eyJ")).toBe("workos:eyJ");
    expect(ensureWorkosPrefix("workos:eyJ")).toBe("workos:eyJ");
  });

  it("refreshes via Cline's endpoint and adds the prefix to a bare JWT", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { accessToken: "bare-jwt", refreshToken: "new-rt" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const creds = await refreshWorkosToken(
      { access: "workos:old", refresh: "rt", expires: 0 },
      { fetch: fetchMock, apiBase: "https://api.cline.bot" },
    );
    expect(creds.access).toBe("workos:bare-jwt");
    expect(creds.refresh).toBe("new-rt");
    expect(creds.expires).toBeGreaterThan(Date.now());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.cline.bot/api/v1/auth/refresh");
    expect(JSON.parse(init.body)).toEqual({
      granttype: "refresh_token",
      refreshToken: "rt",
    });
  });

  it("throws on non-OK refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    await expect(
      refreshWorkosToken(
        { access: "workos:old", refresh: "rt", expires: 0 },
        { fetch: fetchMock },
      ),
    ).rejects.toThrow(/refresh failed/);
  });

  it("honors slow_down by backing off before polling again (RFC 8628)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "slow_down" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const promise = pollDeviceAuthorization(
        { deviceCode: "d", expiresInSeconds: 60, intervalSeconds: 1 },
        { fetch: fetchMock },
      );
      await vi.advanceTimersByTimeAsync(7000);
      const result = await promise;
      expect(result).toEqual({ accessToken: "at", refreshToken: "rt" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
