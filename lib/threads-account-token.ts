import { db } from "./db.js";
import { refreshThreadsLongLivedToken } from "./threads.js";
import { decryptThreadsToken, encryptThreadsToken } from "./threads-token.js";

const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60_000;
const REFRESH_LEASE_MS = 60_000;
const FAILED_REFRESH_RETRY_MS = 6 * 60 * 60_000;

/** Refresh an account token near/after expiry, protected by a database lease. */
export async function getThreadsAccountAccessToken(accountId: string, forceRefresh = false): Promise<{ accessToken: string; expiresAt: Date; refreshed: boolean }> {
  let account = await db.threadsAccount.findUnique({ where: { id: accountId }, select: { id: true, accessToken: true, tokenExpires: true, tokenRefreshLockUntil: true } });
  if (!account) throw new Error("Akun Threads tidak ditemukan.");

  const now = new Date();
  if (!forceRefresh && account.tokenExpires.getTime() > now.getTime() + REFRESH_WINDOW_MS) return { accessToken: decryptThreadsToken(account.accessToken), expiresAt: account.tokenExpires, refreshed: false };

  const leaseUntil = new Date(now.getTime() + REFRESH_LEASE_MS);
  const claimed = await db.threadsAccount.updateMany({
    where: { id: account.id, tokenExpires: account.tokenExpires, OR: [{ tokenRefreshLockUntil: null }, { tokenRefreshLockUntil: { lt: now } }] },
    data: { tokenRefreshLockUntil: leaseUntil }
  });
  if (!claimed.count) {
    account = await db.threadsAccount.findUnique({ where: { id: account.id }, select: { id: true, accessToken: true, tokenExpires: true, tokenRefreshLockUntil: true } });
    if (!account) throw new Error("Akun Threads tidak ditemukan.");
    return { accessToken: decryptThreadsToken(account.accessToken), expiresAt: account.tokenExpires, refreshed: false };
  }

  try {
    const result = await refreshThreadsLongLivedToken(decryptThreadsToken(account.accessToken));
    const saved = await db.threadsAccount.updateMany({
      where: { id: account.id, tokenExpires: account.tokenExpires, tokenRefreshLockUntil: leaseUntil },
      data: { accessToken: encryptThreadsToken(result.accessToken), tokenExpires: result.expiresAt, tokenRefreshLockUntil: null, tokenInvalidAt: null, tokenLastError: null }
    });
    if (saved.count) return { accessToken: result.accessToken, expiresAt: result.expiresAt, refreshed: true };
    const latest = await db.threadsAccount.findUnique({ where: { id: account.id }, select: { accessToken: true, tokenExpires: true } });
    if (!latest) throw new Error("Akun Threads tidak ditemukan.");
    return { accessToken: decryptThreadsToken(latest.accessToken), expiresAt: latest.tokenExpires, refreshed: false };
  } catch (error) {
    await db.threadsAccount.updateMany({ where: { id: account.id, tokenRefreshLockUntil: leaseUntil }, data: { tokenRefreshLockUntil: new Date(Date.now() + FAILED_REFRESH_RETRY_MS) } });
    throw error;
  }
}


