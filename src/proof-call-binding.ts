import { createHash, timingSafeEqual } from "node:crypto";

const EXACT_E164_RE = /^\+[1-9]\d{7,14}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export const normalizeExactProofCallTarget = (value: unknown): string | null => {
  const target = typeof value === "string" ? value.trim() : "";
  return EXACT_E164_RE.test(target) ? target : null;
};

export const digestExactProofCallTarget = (value: unknown): string | null => {
  const target = normalizeExactProofCallTarget(value);
  return target ? createHash("sha256").update(target, "utf8").digest("hex") : null;
};

export const exactProofCallTargetMatchesDigest = (value: unknown, expectedDigest: unknown): boolean => {
  const actualDigest = digestExactProofCallTarget(value);
  const normalizedExpected = typeof expectedDigest === "string" ? expectedDigest.trim().toLowerCase() : "";
  if (!actualDigest || !SHA256_HEX_RE.test(normalizedExpected)) return false;
  return timingSafeEqual(Buffer.from(actualDigest, "hex"), Buffer.from(normalizedExpected, "hex"));
};
