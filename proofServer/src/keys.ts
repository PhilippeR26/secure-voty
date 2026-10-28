import { createHash, randomBytes } from "crypto";

export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
