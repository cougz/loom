import { describe, expect, it } from "vitest";
import { deriveUserId } from "../server/auth.js";

describe("auth", () => {
  describe("deriveUserId", () => {
    it("should derive a consistent userId from a sub claim", async () => {
      const sub = "user-123@example.com";
      const userId1 = await deriveUserId(sub);
      const userId2 = await deriveUserId(sub);

      expect(userId1).toBe(userId2);
      expect(userId1).toHaveLength(20);
      expect(userId1).toMatch(/^[a-z0-9]+$/);
    });

    it("should derive different userIds for different subs", async () => {
      const userId1 = await deriveUserId("user1@example.com");
      const userId2 = await deriveUserId("user2@example.com");

      expect(userId1).not.toBe(userId2);
    });

    it("should handle special characters in sub", async () => {
      const sub = "user+test/123@example.com";
      const userId = await deriveUserId(sub);

      expect(userId).toHaveLength(20);
      expect(userId).toMatch(/^[a-z0-9]+$/);
    });
  });
});
