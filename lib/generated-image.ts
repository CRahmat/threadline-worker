import { createHmac, timingSafeEqual } from "node:crypto";

const IMAGE_PATH = /^\/api\/generated-images\/([0-9a-f-]{36})$/i;
const IMAGE_URL_TTL_SECONDS = 24 * 60 * 60;

export function generatedImageId(imageUrl: string) {
  return IMAGE_PATH.exec(imageUrl)?.[1] || null;
}

function imageUrlSecret() {
  // A separate secret allows image links to be revoked without invalidating user sessions.
  return process.env.IMAGE_URL_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "";
}

function imageSignature(id: string, expiresAt: number) {
  const secret = imageUrlSecret();
  if (!secret) throw new Error("Set IMAGE_URL_SECRET (or AUTH_SECRET) before publishing generated images.");
  return createHmac("sha256", secret).update(`${id}.${expiresAt}`).digest("base64url");
}

export function createSignedGeneratedImagePath(id: string, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + IMAGE_URL_TTL_SECONDS;
  return `/api/generated-images/${id}?expires=${expiresAt}&signature=${encodeURIComponent(imageSignature(id, expiresAt))}`;
}

export function hasValidGeneratedImageSignature(id: string, expires: string | null, signature: string | null, now = Date.now()) {
  if (!expires || !signature || !/^\d{10}$/.test(expires)) return false;
  const expiresAt = Number(expires);
  // Reject unusually long-lived links even if a signing secret was accidentally exposed.
  if (expiresAt < Math.floor(now / 1000) || expiresAt > Math.floor(now / 1000) + IMAGE_URL_TTL_SECONDS + 60) return false;
  try {
    const expected = Buffer.from(imageSignature(id, expiresAt));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  } catch { return false; }
}

export function resolvePublishImageUrl(imageUrl: string | null) {
  const imageId = imageUrl ? generatedImageId(imageUrl) : null;
  if (!imageUrl || !imageId) return imageUrl;
  const configuredBase = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  let base: URL;
  try { base = new URL(configuredBase); } catch { throw new Error("Set PUBLIC_BASE_URL to your public HTTPS app URL before publishing generated images to Threads."); }
  if (base.protocol !== "https:" || ["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Generated images need a public HTTPS app URL. Set PUBLIC_BASE_URL before publishing to Threads.");
  return new URL(createSignedGeneratedImagePath(imageId), base).toString();
}
