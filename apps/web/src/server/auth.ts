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
  aud: string | string[];
  exp: number;
  iss: string;
};

/**
 * Platform JWT — issued by the Worker to a sandbox at spawn time. The sandbox
 * presents it on every MCP request via `Authorization: Bearer <token>`. Unlike
 * the Access JWT, the platform JWT is signed with a shared HMAC secret
 * (PLATFORM_JWT_SECRET) and has an internal issuer + audience.
 */
export type PlatformJwtPayload = {
  sub: UserId;
  session_id: string;
  iat: number;
  exp: number;
  iss: "loom";
  aud: "loom-mcp";
};

const PLATFORM_JWT_TTL_SECONDS = 7200; // 2h — sandbox reconnects on expiry.

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
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);

  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, data);

  if (!valid) {
    throw new Error("Invalid JWT signature");
  }

  // Decode payload
  // @ts-expect-error parts[1] exists at this point
  const payloadJson = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
  const payload = JSON.parse(payloadJson) as JwtPayload;

  // Verify audience (aud may be a string or string[] per CF Access spec)
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(env.CF_ACCESS_AUD)) {
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
 * base64url encode bytes (RFC 4648 §5 — no padding, URL-safe alphabet).
 */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * base64url decode to bytes.
 */
function base64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const canonical = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(canonical);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * Mint a platform JWT binding a sandbox session to a userId. The sandbox
 * presents this on every /mcp call via `Authorization: Bearer <token>`;
 * rotating PLATFORM_JWT_SECRET invalidates all live tokens.
 */
export async function signPlatformJwt(
  userId: UserId,
  sessionId: string,
  secret: string,
  ttlSeconds: number = PLATFORM_JWT_TTL_SECONDS,
): Promise<{ token: string; payload: PlatformJwtPayload }> {
  const iat = Math.floor(Date.now() / 1000);
  const payload: PlatformJwtPayload = {
    sub: userId,
    session_id: sessionId,
    iat,
    exp: iat + ttlSeconds,
    iss: "loom",
    aud: "loom-mcp",
  };

  const header = { alg: "HS256", typ: "JWT" };
  const encoder = new TextEncoder();
  const encodedHeader = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importHmacKey(secret, "sign");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const encodedSignature = base64urlEncode(new Uint8Array(signature));

  return { token: `${signingInput}.${encodedSignature}`, payload };
}

/**
 * Verify a platform JWT. Returns the decoded payload on success, throws on
 * signature mismatch, expiry, issuer/audience mismatch, or malformed token.
 */
export async function verifyPlatformJwt(
  token: string,
  secret: string,
): Promise<PlatformJwtPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid platform JWT format");
  }

  const headerPart = parts[0];
  const payloadPart = parts[1];
  const signaturePart = parts[2];
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new Error("Invalid platform JWT format");
  }
  const signingInput = `${headerPart}.${payloadPart}`;

  const key = await importHmacKey(secret, "verify");
  const signature = base64urlDecode(signaturePart);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(signingInput),
  );

  if (!valid) {
    throw new Error("Invalid platform JWT signature");
  }

  const payloadJson = new TextDecoder().decode(base64urlDecode(payloadPart));
  const payload = JSON.parse(payloadJson) as PlatformJwtPayload;

  if (payload.iss !== "loom") {
    throw new Error("Invalid platform JWT issuer");
  }
  if (payload.aud !== "loom-mcp") {
    throw new Error("Invalid platform JWT audience");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    throw new Error("Platform JWT expired");
  }

  return payload;
}

/**
 * Extract and verify a JWT from the request. Accepts either:
 *   - Access JWT via `Cf-Access-Jwt-Assertion` or `Authorization: Bearer ...`
 *   - Platform JWT via `Authorization: Bearer ...` (only when
 *     PLATFORM_JWT_SECRET is set and the token has `iss: "loom"`).
 *
 * Access wins if both are present in the same header chain.
 */
export async function authenticateRequest(
  request: Request,
  env: {
    CF_ACCESS_TEAM_DOMAIN: string;
    CF_ACCESS_AUD: string;
    PLATFORM_KV: KVNamespace;
    PLATFORM_JWT_SECRET?: string;
  },
): Promise<AuthContext> {
  const cfJwt = request.headers.get("Cf-Access-Jwt-Assertion");
  const authHeader = request.headers.get("Authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // Prefer the dedicated Access header when present.
  if (cfJwt) {
    const payload = await verifyAccessJwt(cfJwt, env);
    const userId = await deriveUserId(payload.sub);
    return { userId, email: payload.email, keys: createKeys(userId) };
  }

  if (!bearer) {
    throw new Error("No JWT found in request");
  }

  // Peek at the token payload to choose verifier. A platform JWT identifies
  // itself via `iss: "loom"`; anything else is treated as an Access JWT.
  let looksLikePlatform = false;
  try {
    const parts = bearer.split(".");
    const payloadPart = parts[1];
    if (parts.length === 3 && payloadPart) {
      const peek = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadPart))) as {
        iss?: unknown;
      };
      looksLikePlatform = peek.iss === "loom";
    }
  } catch {
    // Malformed payload — fall through to Access verification, which will reject.
  }

  if (looksLikePlatform) {
    if (!env.PLATFORM_JWT_SECRET) {
      throw new Error("Platform JWT presented but PLATFORM_JWT_SECRET is not configured");
    }
    const payload = await verifyPlatformJwt(bearer, env.PLATFORM_JWT_SECRET);
    return {
      userId: payload.sub,
      // Platform JWTs do not carry the user's email. Keep the contract (email
      // required) but leave it blank — MCP operations look only at userId.
      email: "",
      keys: createKeys(payload.sub),
    };
  }

  const payload = await verifyAccessJwt(bearer, env);
  const userId = await deriveUserId(payload.sub);
  return { userId, email: payload.email, keys: createKeys(userId) };
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
