import { db } from "./db.js";

export const DEFAULT_SCHEDULER = { enabled: false, intervalSeconds: 1800, timezone: "Asia/Jakarta" };
export const SCHEDULER_ID = "threadline-post-worker";

export async function getSchedulerSettings(organizationId: string) {
  if (!process.env.DATABASE_URL?.trim()) return { ...DEFAULT_SCHEDULER, syncedAt: null as Date | null, syncError: null as string | null };
  return await db.schedulerSettings.findUnique({ where: { organizationId } }) ?? { id: "default", organizationId, ...DEFAULT_SCHEDULER, syncedAt: null, syncError: null, updatedAt: new Date(), updatedBy: null };
}

export function isValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return true; } catch { return false; }
}

function zonedSecondOfDay(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return (Number(parts.find((part) => part.type === "hour")?.value) * 3600) + (Number(parts.find((part) => part.type === "minute")?.value) * 60) + Number(parts.find((part) => part.type === "second")?.value);
}

export function alignToSchedulerSlot(date: Date, intervalSeconds: number, timezone: string) {
  if (!Number.isFinite(date.getTime()) || !isValidTimezone(timezone)) throw new Error("Zona waktu master scheduler tidak valid.");
  const interval = Math.max(1, Math.min(3600, Math.floor(intervalSeconds)));
  const candidate = new Date(date);
  candidate.setUTCMilliseconds(0);
  if (candidate < date) candidate.setUTCSeconds(candidate.getUTCSeconds() + 1);
  // Scanning UTC seconds handles half-hour offsets and daylight-saving transitions.
  for (let i = 0; i <= 3600; i += 1) {
    if (zonedSecondOfDay(candidate, timezone) % interval === 0) return candidate;
    candidate.setUTCSeconds(candidate.getUTCSeconds() + 1);
  }
  throw new Error("Tidak dapat menemukan slot publikasi pada zona waktu ini.");
}

export async function enqueuePostWorker(scheduleId: string, delaySeconds = 0) {
  const token = process.env.QSTASH_TOKEN?.trim();
  const baseUrl = (process.env.WORKER_BASE_URL || process.env.PUBLIC_BASE_URL)?.trim().replace(/\/$/, "");
  const secret = process.env.CRON_SECRET?.trim();
  const qstashUrl = (process.env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/$/, "");
  if (!token) throw new Error("QSTASH_TOKEN belum diatur; post tetap tersimpan di antrean tetapi worker instan tidak dapat dipanggil.");
  if (!baseUrl || !baseUrl.startsWith("https://")) throw new Error("PUBLIC_BASE_URL harus berupa URL HTTPS publik agar post dapat diproses secara async.");
  if (!secret || secret.length < 24) throw new Error("CRON_SECRET belum diatur atau terlalu pendek.");

  const destination = `${baseUrl}/api/cron/post-worker`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Upstash-Method": "POST", "Upstash-Forward-Authorization": `Bearer ${secret}`, "Upstash-Label": `threadline-post-${scheduleId}`, "Upstash-Retries": "3" };
  if (delaySeconds > 0) headers["Upstash-Delay"] = `${Math.floor(delaySeconds)}s`;
  const response = await fetch(`${qstashUrl}/v2/publish/${destination}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ scheduleId }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store"
  });
  if (!response.ok) throw new Error(await qstashError(response));
}

export async function enqueuePostWorkerContinuation(delaySeconds = 0) {
  const token = process.env.QSTASH_TOKEN?.trim();
  const baseUrl = (process.env.WORKER_BASE_URL || process.env.PUBLIC_BASE_URL)?.trim().replace(/\/$/, "");
  const secret = process.env.CRON_SECRET?.trim();
  const qstashUrl = (process.env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/$/, "");
  if (!token || !baseUrl?.startsWith("https://") || !secret || secret.length < 24) throw new Error("Konfigurasi QStash atau CRON_SECRET belum siap untuk melanjutkan reply.");
  const destination = `${baseUrl}/api/cron/post-worker`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Upstash-Method": "POST", "Upstash-Forward-Authorization": `Bearer ${secret}`, "Upstash-Retries": "3" };
  if (delaySeconds > 0) headers["Upstash-Delay"] = `${Math.ceil(delaySeconds)}s`;
  const response = await fetch(`${qstashUrl}/v2/publish/${destination}`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(15_000),
    cache: "no-store"
  });
  if (!response.ok) throw new Error(await qstashError(response));
}

export async function syncQStashScheduler(input: { enabled: boolean; intervalSeconds: number }) {
  const token = process.env.QSTASH_TOKEN?.trim();
  const baseUrl = (process.env.WORKER_BASE_URL || process.env.PUBLIC_BASE_URL)?.trim().replace(/\/$/, "");
  const secret = process.env.CRON_SECRET?.trim();
  const qstashUrl = (process.env.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/$/, "");
  if (!token) throw new Error("QSTASH_TOKEN belum diatur pada environment aplikasi.");
  if (!baseUrl || !baseUrl.startsWith("https://")) throw new Error("PUBLIC_BASE_URL harus berupa URL HTTPS publik agar worker dapat dipanggil QStash.");
  if (!secret || secret.length < 24) throw new Error("CRON_SECRET belum diatur atau terlalu pendek.");

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (input.enabled) {
    const destination = `${baseUrl}/api/cron/post-worker`;
    const intervalMinutes = input.intervalSeconds / 60;
    headers["Upstash-Cron"] = intervalMinutes === 60 ? "0 * * * *" : intervalMinutes === 1 ? "* * * * *" : `*/${intervalMinutes} * * * *`;
    headers["Upstash-Schedule-Id"] = SCHEDULER_ID;
    headers["Upstash-Method"] = "GET";
    headers["Upstash-Forward-Authorization"] = `Bearer ${secret}`;
    headers["Upstash-Label"] = "threadline-post-worker";
    const response = await fetch(`${qstashUrl}/v2/schedules/${destination}`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(await qstashError(response));
    return;
  }
  const response = await fetch(`${qstashUrl}/v2/schedules/${SCHEDULER_ID}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok && response.status !== 404) throw new Error(await qstashError(response));
}

async function qstashError(response: Response) {
  const body = (await response.text()).slice(0, 500);
  return `QStash gagal memperbarui scheduler (${response.status}). ${body || response.statusText}`;
}

