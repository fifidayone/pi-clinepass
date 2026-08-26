/**
 * WorkOS OAuth protocol adapter for ClinePass.
 *
 * Owns: token prefix detection, server-side token refresh, the device-code
 * authorization flow, and credential extraction from Cline CLI / pi auth
 * stores. All I/O is injectable for testability.
 */

import type { OAuthCredentials } from "@earendil-works/pi-ai";

export const WORKOS_API_BASE = "https://api.workos.com";
export const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
export const WORKOS_TOKEN_PREFIX = "workos:";
export const DEFAULT_API_BASE = "https://api.cline.bot";

export const CLINE_REFRESH_ENDPOINT = "/api/v1/auth/refresh";
export const CLINE_REGISTER_ENDPOINT = "/api/v1/auth/register";
export const WORKOS_DEVICE_ENDPOINT = "/user_management/authorize/device";
export const WORKOS_AUTH_ENDPOINT = "/user_management/authenticate";

/** Conservative lifetime estimate; WorkOS tokens live ~1 hour. */
export const WORKOS_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
/** Refresh 5 minutes before expiry to avoid races. */
export const WORKOS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** Refresh request timeout. */
export const WORKOS_REFRESH_TIMEOUT_MS = 15_000;

export interface WorkosOptions {
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
}

export function isWorkosToken(token: string): boolean {
  return token.startsWith(WORKOS_TOKEN_PREFIX);
}

/** Ensure a bare JWT gets the `workos:` prefix the chat API requires. */
export function ensureWorkosPrefix(token: string): string {
  return isWorkosToken(token) ? token : `${WORKOS_TOKEN_PREFIX}${token}`;
}

export interface ClineAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

// ─── Token refresh ────────────────────────────────────────────────────────

/**
 * Refresh a WorkOS access token via Cline's server-side endpoint.
 * The response is `{ data: { accessToken, refreshToken } }` or flat; the new
 * access token needs the `workos:` prefix when the API returns a bare JWT.
 */
export async function refreshWorkosToken(
  credentials: OAuthCredentials,
  options: WorkosOptions = {},
): Promise<OAuthCredentials> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;

  let response: Response;
  try {
    response = await fetchFn(`${apiBase}${CLINE_REFRESH_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        granttype: "refresh_token",
        refreshToken: credentials.refresh,
      }),
      signal: AbortSignal.timeout(WORKOS_REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("ClinePass token refresh timed out — check your network.", { cause: err });
    }
    throw err;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`ClinePass token refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    data?: { accessToken?: string; refreshToken?: string };
    accessToken?: string;
    refreshToken?: string;
  };
  const tokens = data.data ?? data;
  const accessToken = tokens.accessToken;
  const refreshToken = tokens.refreshToken;
  if (!accessToken || !refreshToken) {
    throw new Error("ClinePass token refresh returned an unexpected response format");
  }

  return {
    access: ensureWorkosPrefix(accessToken),
    refresh: refreshToken,
    expires: Date.now() + WORKOS_TOKEN_LIFETIME_MS - WORKOS_REFRESH_MARGIN_MS,
  };
}

// ─── Device-code flow ─────────────────────────────────────────────────────

export async function startDeviceAuthorization(
  options: WorkosOptions = {},
): Promise<DeviceAuthorization> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const response = await fetchFn(`${WORKOS_API_BASE}${WORKOS_DEVICE_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(
      `Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresInSeconds: data.expires_in ?? 300,
    intervalSeconds: data.interval ?? 5,
  };
}

export async function pollDeviceAuthorization(
  params: { deviceCode: string; expiresInSeconds: number; intervalSeconds: number },
  options: WorkosOptions = {},
): Promise<{ accessToken: string; refreshToken: string }> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const deadline = Date.now() + params.expiresInSeconds * 1000;
  let intervalSeconds = Math.max(1, params.intervalSeconds);

  while (Date.now() <= deadline) {
    const response = await fetchFn(`${WORKOS_API_BASE}${WORKOS_AUTH_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: params.deviceCode,
        client_id: WORKOS_CLIENT_ID,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (response.ok && data.access_token && data.refresh_token) {
      return { accessToken: data.access_token, refreshToken: data.refresh_token };
    }
    if (data.error === "authorization_pending") {
      await sleep(intervalSeconds * 1000);
      continue;
    }
    if (data.error === "slow_down") {
      // RFC 8628: increase the polling interval by 5 seconds.
      intervalSeconds += 5;
      await sleep(intervalSeconds * 1000);
      continue;
    }
    throw new Error(
      `Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
    );
  }
  throw new Error("Cline device authorization timed out");
}

/** Exchange WorkOS tokens for Cline tokens via /api/v1/auth/register. */
export async function registerWorkOSTokens(
  tokens: { accessToken: string; refreshToken: string },
  options: WorkosOptions = {},
): Promise<OAuthCredentials> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const response = await fetchFn(`${apiBase}${CLINE_REGISTER_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "pi-clinepass" },
    body: JSON.stringify(tokens),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`Cline token registration failed (${response.status}): ${text}`);
  }
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { accessToken?: string; refreshToken?: string; expiresAt?: string };
  };
  const data = payload.data;
  if (!payload.success || !data?.accessToken || !data.expiresAt) {
    throw new Error("Invalid token response from Cline");
  }
  const refreshToken = data.refreshToken ?? tokens.refreshToken;
  const expires = Date.parse(data.expiresAt);
  if (Number.isNaN(expires)) {
    throw new Error(`Invalid token expiration from Cline: ${data.expiresAt}`);
  }
  return {
    access: ensureWorkosPrefix(data.accessToken),
    refresh: refreshToken,
    expires: expires - WORKOS_REFRESH_MARGIN_MS,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
