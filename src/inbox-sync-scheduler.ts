const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 15 * 60_000;

export function startInboxSyncScheduler() {
  const appUrl = (process.env.APP_INTERNAL_URL || process.env.PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  const secret = process.env.CRON_SECRET?.trim();
  if (!appUrl || !secret) {
    console.warn("Inbox sync scheduler disabled: APP_INTERNAL_URL and CRON_SECRET are required.");
    return () => {};
  }

  const configuredInterval = Number.parseInt(process.env.INBOX_SYNC_POLL_INTERVAL_MS || "", 10);
  const intervalMs = Number.isFinite(configuredInterval)
    ? Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, configuredInterval))
    : DEFAULT_POLL_INTERVAL_MS;
  let busy = false;

  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`${appUrl}/api/cron/inbox-sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        cache: "no-store",
        signal: AbortSignal.timeout(20_000)
      });
      const result = await response.json().catch(() => ({})) as { accounts?: number; failed?: number; skipped?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || `Inbox sync endpoint returned ${response.status}.`);
      if (!result.skipped && (result.accounts || result.failed)) {
        console.info("inbox-sync completed", { accounts: result.accounts || 0, failed: result.failed || 0 });
      }
    } catch (error) {
      console.error("Scheduled inbox sync failed", { message: error instanceof Error ? error.message.slice(0, 300) : "Unknown error" });
    } finally {
      busy = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  console.info("inbox-sync scheduler started", { intervalMs });
  return () => clearInterval(timer);
}
