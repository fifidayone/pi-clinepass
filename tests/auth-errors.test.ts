import { describe, expect, it } from "vitest";
import { persistOAuthCredential, sanitizeApiKey } from "../src/auth.js";
import { classifyClinePassError } from "../src/errors.js";

describe("auth", () => {
  it("strips terminal paste wrappers and control chars", () => {
    const input = "\u001b[200~sk-abc123\u001b[201~\n";
    expect(sanitizeApiKey(input)).toBe("sk-abc123");
    expect(sanitizeApiKey("  sk-abc123  ")).toBe("sk-abc123");
  });
});

describe("persistOAuthCredential", () => {
  const AUTH_JSON = "/home/test/.pi/agent/auth.json";
  /** Normalize Windows path separators so fixtures can use forward slashes. */
  const norm = (p: string): string => p.replace(/\\/g, "/");

  const makeFs = (files: Record<string, string>) => ({
    homeDir: () => "/home/test",
    readFile: (p: string) => {
      const content = files[norm(p)];
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return content;
    },
    fileExists: (p: string) => Object.prototype.hasOwnProperty.call(files, norm(p)),
    writeFile: (p: string, d: string) => {
      files[norm(p)] = d;
    },
  });

  it("merges rotated oauth credentials into auth.json, preserving others", async () => {
    const files: Record<string, string> = {
      [AUTH_JSON]: JSON.stringify({
        clinepass: { type: "oauth", access: "workos:old", refresh: "old-rt", expires: 1 },
        anthropic: { type: "api_key", key: "sk-keep" },
      }),
    };
    await persistOAuthCredential(
      { access: "workos:new", refresh: "new-rt", expires: 42 },
      makeFs(files),
    );
    const saved = JSON.parse(files[AUTH_JSON]);
    expect(saved.clinepass).toEqual({ type: "oauth", access: "workos:new", refresh: "new-rt", expires: 42 });
    expect(saved.anthropic).toEqual({ type: "api_key", key: "sk-keep" });
  });

  it("creates the clinepass entry when auth.json has none", async () => {
    const files: Record<string, string> = {};
    await persistOAuthCredential(
      { access: "workos:new", refresh: "new-rt", expires: 42 },
      makeFs(files),
    );
    const saved = JSON.parse(files[AUTH_JSON]);
    expect(saved.clinepass).toEqual({ type: "oauth", access: "workos:new", refresh: "new-rt", expires: 42 });
  });

  it("redoes the merge when pi rewrites auth.json during persist (lost update)", async () => {
    const files: Record<string, string> = {
      [AUTH_JSON]: JSON.stringify({ anthropic: { type: "api_key", key: "sk-keep" } }),
    };
    const base = makeFs(files);
    let simulated = false;
    const fs = {
      ...base,
      writeFile: (p: string, d: string) => {
        base.writeFile(p, d);
        // Simulate pi's own refresh persisting right after ours: its rewrite
        // lands after our write but before the lost-update check.
        if (!simulated && norm(p) === AUTH_JSON) {
          simulated = true;
          files[AUTH_JSON] = JSON.stringify({
            anthropic: { type: "api_key", key: "sk-keep" },
            anthropic2: { type: "oauth", access: "workos:pi" },
          });
        }
      },
    };
    await persistOAuthCredential({ access: "workos:new", refresh: "new-rt", expires: 42 }, fs);
    const saved = JSON.parse(files[AUTH_JSON]);
    expect(saved.clinepass).toEqual({ type: "oauth", access: "workos:new", refresh: "new-rt", expires: 42 });
    expect(saved.anthropic).toEqual({ type: "api_key", key: "sk-keep" });
    // pi's concurrent update must survive our re-merge.
    expect(saved.anthropic2).toEqual({ type: "oauth", access: "workos:pi" });
  });
});

describe("errors", () => {
  it("classifies subscription errors", () => {
    const r = classifyClinePassError("HTTP 403 Forbidden: subscription required");
    expect(r.type).toBe("not_subscribed");
  });
  it("classifies org-account errors as not_subscribed", () => {
    const r = classifyClinePassError("organization accounts cannot use individual model inference subscriptions");
    expect(r.type).toBe("not_subscribed");
  });
  it("classifies auth, rate-limit, and free-limit errors", () => {
    expect(classifyClinePassError("401 unauthorized").type).toBe("auth_expired");
    expect(classifyClinePassError("429 too many requests").type).toBe("rate_limited");
    expect(classifyClinePassError("free limit reached. try again in 10 minutes").type).toBe("free_limit_reached");
  });
  it("free-limit errors win over a generic 403 wrapper", () => {
    expect(classifyClinePassError("HTTP 403: free limit reached").type).toBe("free_limit_reached");
  });
  it("classifies free-model 403 as free_route_forbidden, paid 403 as not_subscribed", () => {
    expect(classifyClinePassError("HTTP 403 Forbidden", "cline-free/deepseek-v4.1-flash").type).toBe("free_route_forbidden");
    expect(classifyClinePassError("HTTP 403 Forbidden", "stealth/space-bunny-alpha").type).toBe("free_route_forbidden");
    expect(classifyClinePassError("HTTP 403 Forbidden", "cline-pass/kimi-k3").type).toBe("not_subscribed");
  });
  it("classifies upstream provider errors containing 401 or invalid_api_key as upstream_error, not auth_expired", () => {
    const upstreamError =
      'Failed to create stream: inference request failed: failed to generate stream from OpenRouter: failed to invoke model with streaming: request failed with status 401: {"error":{"message":"Provider returned error","code":401,"metadata":{"raw":"{\\"error\\":{\\"code\\":\\"invalid_api_key\\"}}"}}}';
    const result = classifyClinePassError(upstreamError);
    expect(result.type).toBe("upstream_error");
    expect(result.message).not.toContain("Run `pi /login`");
  });
  it("classifies insufficient credits as insufficient_credits", () => {
    const r = classifyClinePassError('402: {"code":"insufficient_credits","message":"Insufficient balance"}');
    expect(r.type).toBe("insufficient_credits");
  });
  it("classifies model not found as model_not_found", () => {
    expect(classifyClinePassError('404 "model not found"').type).toBe("model_not_found");
  });
  it("classifies gateway 5xx as server_error", () => {
    expect(classifyClinePassError("502 Bad Gateway").type).toBe("server_error");
    expect(classifyClinePassError("503 Service Unavailable").type).toBe("server_error");
  });
  it("does not match non-401 numbers as auth_expired", () => {
    expect(classifyClinePassError("error code 4012").type).toBe("unknown");
  });
  it("falls back to unknown", () => {
    expect(classifyClinePassError("weird upstream issue").type).toBe("unknown");
  });
});
