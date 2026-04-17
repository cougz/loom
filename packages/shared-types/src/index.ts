// Shared types across loom workers. Keep this file small and
// dependency-free — both the main Worker and the outbound Worker
// consume it.

export type UserId = string & { readonly __brand: "UserId" };

export type ResourceType = "worker" | "r2" | "kv" | "d1" | "route" | "dns";

export type Resource = {
  userId: UserId;
  type: ResourceType;
  name: string;
  createdAt: number;
};

// Egress headers tagged on requests leaving user-deployed skills, read
// by the outbound Worker for audit + policy enforcement.
export const EGRESS_USER_HEADER = "x-loom-user-id";
export const EGRESS_SKILL_HEADER = "x-loom-skill";
