import { describe, expect, it } from "vitest";
import { getOAuthCallbackPort, matchProxyTarget } from "../server/opencode-proxy-routing.js";

describe("opencode-proxy routing", () => {
  describe("matchProxyTarget", () => {
    it("parses /opencode/<id>/<rest>", () => {
      const target = matchProxyTarget(
        new URL("https://loom.example.com/opencode/abc/api/session.list"),
      );
      expect(target).not.toBeNull();
      expect(target?.sandboxId).toBe("abc");
      expect(target?.rest).toBe("/api/session.list");
      expect(target?.port).toBe(4096);
    });

    it("parses /opencode-oauth/<id>/<rest> with full pathname preserved", () => {
      const target = matchProxyTarget(
        new URL("https://loom.example.com/opencode-oauth/xyz/mcp/oauth/callback?code=abc"),
      );
      expect(target).not.toBeNull();
      expect(target?.sandboxId).toBe("xyz");
      // OAuth callback proxying must forward the full pathname (OpenCode
      // binds the listener with the prefix intact).
      expect(target?.rest).toBe("/opencode-oauth/xyz/mcp/oauth/callback");
    });

    it("returns null when the sandboxId segment is empty", () => {
      expect(matchProxyTarget(new URL("https://loom.example.com/opencode//x"))).toBeNull();
      expect(
        matchProxyTarget(new URL("https://loom.example.com/opencode-oauth//callback")),
      ).toBeNull();
    });

    it("returns null when there's no slash after the sandboxId", () => {
      expect(matchProxyTarget(new URL("https://loom.example.com/opencode/abc"))).toBeNull();
    });

    it("returns null for unrelated paths", () => {
      expect(matchProxyTarget(new URL("https://loom.example.com/dash/"))).toBeNull();
      expect(matchProxyTarget(new URL("https://loom.example.com/mcp"))).toBeNull();
      expect(matchProxyTarget(new URL("https://loom.example.com/view/abc/"))).toBeNull();
    });
  });

  describe("getOAuthCallbackPort", () => {
    it("returns the URL port when one is set", () => {
      expect(getOAuthCallbackPort(new URL("http://localhost:8787/x"))).toBe(8787);
      expect(getOAuthCallbackPort(new URL("https://loom.example.com:9999/x"))).toBe(9999);
    });

    it("falls back to 443 for https without an explicit port", () => {
      expect(getOAuthCallbackPort(new URL("https://loom.example.com/x"))).toBe(443);
    });

    it("falls back to 80 for http without an explicit port", () => {
      expect(getOAuthCallbackPort(new URL("http://loom.example.com/x"))).toBe(80);
    });
  });
});
