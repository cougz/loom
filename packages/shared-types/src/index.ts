// Shared types used across the loom Worker. Keep this file small and
// dependency-free.

export type UserId = string & { readonly __brand: "UserId" };

export type ResourceType = "r2" | "kv" | "d1" | "publication";

export type Resource = {
  userId: UserId;
  type: ResourceType;
  name: string;
  createdAt: number;
};
