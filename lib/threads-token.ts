import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "enc:v1:";

function encryptionKey() {
  const configured = process.env.THREADS_TOKEN_ENCRYPTION_KEY?.trim();
  if (!configured) throw new Error("THREADS_TOKEN_ENCRYPTION_KEY must be configured to store Threads tokens.");
  const key = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64url");
  if (key.length !== 32) throw new Error("THREADS_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes as hex or base64url.");
  return key;
}

export function isEncryptedThreadsToken(token: string) {
  return token.startsWith(TOKEN_PREFIX);
}

export function encryptThreadsToken(token: string) {
  if (!token) throw new Error("Cannot encrypt an empty Threads access token.");
  if (isEncryptedThreadsToken(token)) return token;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${TOKEN_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptThreadsToken(token: string) {
  if (!isEncryptedThreadsToken(token)) return token;
  const [ivValue, tagValue, ciphertextValue] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Stored Threads access token has an invalid encrypted format.");
  const key = encryptionKey();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt this Threads access token. Check THREADS_TOKEN_ENCRYPTION_KEY.");
  }
}
