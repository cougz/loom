import { describe, expect, it } from "vitest";
import type { UserId } from "../server/auth.js";
import { createKeys, extractUserIdFromPublicationKey } from "../server/keys.js";

describe("keys", () => {
  describe("createKeys", () => {
    const userId = "testuser123456789012" as UserId;
    const keys = createKeys(userId);

    it("should create workspace snapshot key", () => {
      const key = keys.workspaceSnapshot(1);
      expect(key).toBe("users/testuser123456789012/snapshots/v1.tar.gz");
    });

    it("should create publication key without path", () => {
      const key = keys.publication("abc123");
      expect(key).toBe("publications/testuser123456789012/abc123");
    });

    it("should create publication key with path", () => {
      const key = keys.publication("abc123", "index.html");
      expect(key).toBe("publications/testuser123456789012/abc123/index.html");
    });

    it("should create tool attachment key", () => {
      const key = keys.toolAttachment("tool-1", "attach-1");
      expect(key).toBe("users/testuser123456789012/tools/tool-1/attachments/attach-1");
    });

    it("should create kv key", () => {
      const key = keys.kv("mykey");
      expect(key).toBe("user:testuser123456789012:mykey");
    });
  });

  describe("extractUserIdFromPublicationKey", () => {
    it("should extract userId from publication key", () => {
      const key = "publications/user123/index.html";
      const userId = extractUserIdFromPublicationKey(key);
      expect(userId).toBe("user123");
    });

    it("should return undefined for non-publication key", () => {
      const key = "users/user123/snapshots/v1.tar.gz";
      const userId = extractUserIdFromPublicationKey(key);
      expect(userId).toBeUndefined();
    });

    it("should handle nested paths", () => {
      const key = "publications/user123/path/to/file.txt";
      const userId = extractUserIdFromPublicationKey(key);
      expect(userId).toBe("user123");
    });
  });
});
