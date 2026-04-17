/**
 * User-scoped key helpers.
 *
 * Every persistent resource in loom is partitioned by userId. These helpers
 * construct fully-qualified keys/names that include the user prefix.
 *
 * Invariant: No code should concatenate userId into a key path directly.
 * Always use these helpers.
 */

import type { UserId } from "./auth.js";

export type Keys = {
  workspaceSnapshot(version: number): string;
  publication(shortId: string, path?: string): string;
  toolAttachment(toolId: string, attachmentId: string): string;
  kv(key: string): string;
};

/**
 * Create a Keys instance scoped to a specific user.
 */
export function createKeys(userId: UserId): Keys {
  return {
    workspaceSnapshot(version: number): string {
      return `users/${userId}/snapshots/v${version}.tar.gz`;
    },

    publication(shortId: string, path = ""): string {
      if (path) {
        return `publications/${userId}/${shortId}/${path}`;
      }
      return `publications/${userId}/${shortId}`;
    },

    toolAttachment(toolId: string, attachmentId: string): string {
      return `users/${userId}/tools/${toolId}/attachments/${attachmentId}`;
    },

    kv(key: string): string {
      return `user:${userId}:${key}`;
    },
  };
}

/**
 * Extract userId from a publication key for /view lookup.
 * Returns undefined if the key doesn't match the expected pattern.
 */
export function extractUserIdFromPublicationKey(key: string): UserId | undefined {
  const match = key.match(/^publications\/([^/]+)\//);
  if (!match) return undefined;
  return match[1] as UserId;
}
