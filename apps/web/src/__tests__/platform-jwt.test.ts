import { describe, expect, it } from "vitest";
import type { UserId } from "../server/auth.js";
import { signPlatformJwt, verifyPlatformJwt } from "../server/auth.js";

const SECRET = "test-secret-do-not-use-in-production";
const USER_ID = "abc123def456ghi789jk" as UserId;

describe("platform JWT", () => {
  it("round-trips a signed token", async () => {
    const { token, payload } = await signPlatformJwt(USER_ID, "sess-123", SECRET);
    const verified = await verifyPlatformJwt(token, SECRET);

    expect(verified.sub).toBe(USER_ID);
    expect(verified.session_id).toBe("sess-123");
    expect(verified.iss).toBe("loom");
    expect(verified.aud).toBe("loom-mcp");
    expect(verified.exp).toBe(payload.exp);
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await signPlatformJwt(USER_ID, "sess-1", SECRET);
    await expect(verifyPlatformJwt(token, "wrong-secret")).rejects.toThrow(/signature/i);
  });

  it("rejects an expired token", async () => {
    const { token } = await signPlatformJwt(USER_ID, "sess-1", SECRET, -10);
    await expect(verifyPlatformJwt(token, SECRET)).rejects.toThrow(/expired/i);
  });

  it("rejects a malformed token", async () => {
    await expect(verifyPlatformJwt("not.a.jwt.at.all", SECRET)).rejects.toThrow(
      /format|signature/i,
    );
    await expect(verifyPlatformJwt("only-one-part", SECRET)).rejects.toThrow(/format/i);
  });

  it("rejects a token with the wrong issuer", async () => {
    // Manually forge a token with bad iss — sign with the real secret so the
    // signature check passes and we hit the iss check.
    const encoder = new TextEncoder();
    const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const badPayload = btoa(
      JSON.stringify({
        sub: USER_ID,
        session_id: "s",
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: "not-loom",
        aud: "loom-mcp",
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signingInput = `${header}.${badPayload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const token = `${signingInput}.${sigB64}`;

    await expect(verifyPlatformJwt(token, SECRET)).rejects.toThrow(/issuer/i);
  });
});
