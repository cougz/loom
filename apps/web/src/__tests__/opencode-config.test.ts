import { describe, expect, it } from "vitest";
import { renderOpencodeConfig } from "../server/opencode-config.js";

describe("renderOpencodeConfig", () => {
  it("renders valid JSON with the expected shape", () => {
    const out = renderOpencodeConfig({
      loomHostname: "loom.example.com",
      platformJwt: "eyJhbGciOiJIUzI1NiJ9.test.sig",
    });
    const parsed = JSON.parse(out);

    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.autoupdate).toBe(false);
    expect(parsed.server.port).toBe(4096);
    expect(parsed.mcp.loom.type).toBe("remote");
    expect(parsed.mcp.loom.url).toBe("https://loom.example.com/mcp");
    expect(parsed.mcp.loom.headers.Authorization).toBe("Bearer eyJhbGciOiJIUzI1NiJ9.test.sig");
  });

  it("allows overriding the port", () => {
    const out = renderOpencodeConfig({
      loomHostname: "x.example.com",
      platformJwt: "token",
      port: 5000,
    });
    expect(JSON.parse(out).server.port).toBe(5000);
  });

  it("embeds the JWT verbatim (does not re-encode)", () => {
    const jwt = "aaa.bbb.ccc";
    const out = renderOpencodeConfig({ loomHostname: "h", platformJwt: jwt });
    expect(out).toContain(`"Bearer ${jwt}"`);
  });
});
