/**
 * Authentication — Cloudflare Access JWT verification.
 *
 * userId is derived exclusively from the verified JWT sub claim.
 * Never from request body, headers (other than Cf-Access-Jwt-Assertion),
 * or URL parameters.
 */

import type { Keys } from "./keys.js";
import { createKeys } from "./keys.js";

export type UserId = string & { __brand: "UserId" };

export type AuthContext = {
  userId: UserId;
  email: string;
  keys: Keys;
};

export type JwtPayload = {
  sub: string;
  email: string;
  aud: string;
  exp: number;
  iss: string;
};

/**
 * Derive userId from Access JWT sub claim.
 * Algorithm: sha256(sub) → base32hex(0, 20).toLowerCase()
 */
export async function deriveUserId(sub: string): Promise<UserId> {
  const encoder = new TextEncoder();
  const data = encoder.encode(sub);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);

  // Base32hex encoding, take first 20 chars
  const base32hex = "0123456789abcdefghijklmnopqrstuv";
  let result = "";
  let bits = 0;
  let value = 0;

  for (const byte of hashArray) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      result += base32hex[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }

    if (result.length >= 20) break;
  }

  return result.slice(0, 20).toLowerCase() as UserId;
}

/**
 * Fetch JWKS from Cloudflare Access.
 */
async function fetchJwks(teamDomain: string): Promise<Record<string, unknown>> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * Get cached JWKS from KV or fetch fresh.
 * Cache TTL: 10 minutes.
 */
async function getCachedJwks(
  env: { PLATFORM_KV: KVNamespace },
  teamDomain: string,
): Promise<Record<string, unknown>> {
  const cacheKey = `jwks:${teamDomain}`;
  const cached = await env.PLATFORM_KV.get(cacheKey, "json");

  if (cached) {
    return cached as Record<string, unknown>;
  }

  const jwks = await fetchJwks(teamDomain);
  await env.PLATFORM_KV.put(cacheKey, JSON.stringify(jwks), {
    expirationTtl: 600, // 10 minutes
  });

  return jwks;
}

/**
 * Import a JWK as a CryptoKey for verification.
 */
async function importJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Verify an Access JWT.
 * Returns the decoded payload if valid, throws otherwise.
 */
export async function verifyAccessJwt(
  token: string,
  env: {
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUD: string;
    PLATFORM_KV: KVNamespace;
  },
): Promise<JwtPayload> {
  // Split JWT
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  // Decode header to get kid
  // @ts-expect-error parts[0] exists at this point
  const headerJson = atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"));
  const header = JSON.parse(headerJson) as { kid?: string };

  if (!header.kid) {
    throw new Error("JWT header missing kid");
  }

  // Get JWKS
  const jwks = await getCachedJwks(env, env.CF_ACCESS_TEAM_DOMAIN);
  const keys = jwks.keys as Array<{ kid: string; [key: string]: unknown }> | undefined;

  if (!keys) {
    throw new Error("JWKS missing keys array");
  }

  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error(`Key ${header.kid} not found in JWKS`);
  }

  // Import key
  // @ts-expect-error JWKS key shape varies
  const cryptoKey = await importJwk(key as JsonWebKey);

  // Verify signature
  // @ts-expect-error parts checked above
  const signature = Uint8Array.from(atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  // @ts-expect-error parts checked above
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, data);

  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  // Decode payload
  // @ts-expect-error parts[1] exists at this point
  const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(payloadJson) as JwtPayload;

  // Verify audience
  if (payload.aud !== env.CF_ACCESS_AUD) {
    throw new Error("Invalid audience");
  }

  // Verify expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error("JWT expired");
  }

  // Verify issuer
  const expectedIssuer = `https://${env.CF_ACCESS_TEAM_DOMAIN}`;
  if (payload.iss !== expectedIssuer) {
    throw new Error("Invalid issuer");
  }

  return payload;
}

/**
 * Extract and verify Access JWT from request.
 * Supports both Cf-Access-Jwt-Assertion header and Authorization: Bearer header.
 */
export async function authenticateRequest(
  request: Request,
  env: {
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUD: string;
    PLATFORM_KV: KVNamespace;
  },
): Promise<AuthContext> {
  // Get token from headers
  const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion");
  const authHeader = request.headers.get("Authorization");

  let token: string | null = cfJwt;

  if (!token && authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  if (!token) {
    throw new Error("No JWT found in request");
  }

  const payload = await verifyAccessJwt(token, env);
  const userId = await deriveUserId(payload.sub);

  return {
    userId,
    email: payload.email,
    keys: createKeys(userId),
  };
}

/**
 * Create a mock auth context for development mode.
 */
export function createMockAuthContext(): AuthContext {
  const mockUserId = "devuser1234567890123" as UserId;
  return {
    userId: mockUserId,
    email: "dev@localhost",
    keys: createKeys(mockUserId),
  };
}
