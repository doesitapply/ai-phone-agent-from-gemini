import crypto from "node:crypto";

function resolveEncryptionSecret(explicitSecret?: string): string {
  const secret = String(
    explicitSecret
      || process.env.WORKSPACE_SECRET_ENCRYPTION_KEY
      || process.env.PHONE_AGENT_PROVISIONING_SECRET
      || process.env.TWILIO_AUTH_TOKEN
      || "",
  ).trim();
  if (!secret) throw new Error("Workspace secret encryption is not configured.");
  return secret;
}

function buildEncryptionKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptWorkspaceSecret(value: string, explicitSecret?: string): string {
  const plaintext = String(value || "");
  if (!plaintext) throw new Error("Cannot encrypt an empty workspace secret.");
  const iv = crypto.randomBytes(12);
  const key = buildEncryptionKey(resolveEncryptionSecret(explicitSecret));
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptWorkspaceSecret(value: string, explicitSecret?: string): string {
  const encoded = String(value || "").trim();
  const parts = encoded.split(":");
  if (parts.length !== 4 || parts[0] !== "enc") throw new Error("Workspace secret is not in the supported encrypted format.");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("Workspace secret ciphertext is malformed.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", buildEncryptionKey(resolveEncryptionSecret(explicitSecret)), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
