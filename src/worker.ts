
import { db } from "../lib/db.js";
import { enqueuePostWorker, enqueuePostWorkerContinuation } from "../lib/post-scheduler.js";
import { publishReplyToThreads, publishThreadSequence, refreshThreadsLongLivedToken } from "../lib/threads.js";
import { resolvePublishImageUrl } from "../lib/generated-image.js";
import { isRetryablePostError } from "../lib/retry.js";
import { parseThreadPosts } from "../lib/post-thread.js";
import { parsePostImages, serializePostImages } from "../lib/post-images.js";
import { recordAuditEvent } from "../lib/audit.js";
import { decryptThreadsToken, encryptThreadsToken } from "../lib/threads-token.js";
import { getThreadsAccountAccessToken } from "../lib/threads-account-token.js";



const BATCH_SIZE = 5;
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MINUTES = [1, 5, 15] as const;
const WORKER_BUDGET_MS = 45_000;
const STUCK_PROCESSING_MS = 10 * 60_000;

async function refreshExpiringAccountTokens() {
  const now = new Date();
  const refreshBefore = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
  const leaseUntil = new Date(now.getTime() + 60_000);
  const expiredLease = { OR: [{ tokenRefreshLockUntil: null }, { tokenRefreshLockUntil: { lt: now } }] };
  const accounts = await db.threadsAccount.findMany({ where: { isActive: true, tokenExpires: { lte: refreshBefore }, ...expiredLease }, select: { id: true, accessToken: true, tokenExpires: true }, orderBy: { tokenExpires: "asc" }, take: BATCH_SIZE });
  let refreshed = 0;
  for (const account of accounts) {
    const claimed = await db.threadsAccount.updateMany({ where: { id: account.id, isActive: true, tokenExpires: account.tokenExpires, ...expiredLease }, data: { tokenRefreshLockUntil: leaseUntil } });
    if (!claimed.count) continue;
    try {
      const result = await refreshThreadsLongLivedToken(decryptThreadsToken(account.accessToken));
      const saved = await db.threadsAccount.updateMany({ where: { id: account.id, tokenExpires: account.tokenExpires, tokenRefreshLockUntil: leaseUntil }, data: { accessToken: encryptThreadsToken(result.accessToken), tokenExpires: result.expiresAt, tokenRefreshLockUntil: null } });
      if (saved.count) refreshed += 1;
    } catch (error) {
      console.warn("Threads token refresh failed", { accountId: account.id, error: error instanceof Error ? error.message : "Unknown refresh error" });
      const retryAfter = new Date(Date.now() + 6 * 60 * 60_000);
      await db.threadsAccount.updateMany({ where: { id: account.id, tokenRefreshLockUntil: leaseUntil }, data: { tokenRefreshLockUntil: retryAfter } });
    }
  }
  return refreshed;
}

async function runWorker(request: Request, scheduleId?: string) {
  const startedAt = Date.now();
  const secret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization");
  const hasAppSecret = Boolean(secret && Buffer.byteLength(secret) >= 32 && authorization === `Bearer ${secret}`);
  if (!hasAppSecret) return Response.json({ error: "Unauthorized" }, { status: 401 });
  await db.generatedImage.deleteMany({ where: { isCommitted: false, createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
  const tokensRefreshed = await refreshExpiringAccountTokens();
  const recovered = 0;
  // A worker can disappear after Threads accepts a request. Do not retry these jobs:
  // leave an explicit failure record for an operator to reconcile against Threads first.
  const stuckBefore = new Date(Date.now() - STUCK_PROCESSING_MS);
  const stuckSchedules = await db.postSchedule.findMany({ where: { status: { in: ["GENERATING_AI", "PUBLISHING"] }, updatedAt: { lt: stuckBefore } }, take: BATCH_SIZE, orderBy: { updatedAt: "asc" }, include: { product: { select: { title: true } }, account: { select: { accountName: true } } } });
  let reconciliationsNeeded = 0;
  for (const stuck of stuckSchedules) {
    const message = `Worker lease expired while ${stuck.status === "PUBLISHING" ? "publishing" : "preparing"}. Do not retry automatically; reconcile the post in Threads before a manual retry.`;
    const result = await db.$transaction(async (tx) => {
      const updated = await tx.postSchedule.updateMany({ where: { id: stuck.id, status: stuck.status, updatedAt: { lt: stuckBefore } }, data: { status: "FAILED", userUp: null } });
      if (!updated.count) return 0;
      if (stuck.campaignSlotId) await tx.campaignSlot.updateMany({ where: { id: stuck.campaignSlotId }, data: { status: "FAILED" } });
      await tx.postLog.create({ data: { organizationId: stuck.organizationId, scheduleId: stuck.id, productId: stuck.productId, accountId: stuck.accountId, status: "FAILED", errorMessage: message } });
      await recordAuditEvent(tx, { actor: null, organizationId: stuck.organizationId, source: "SYSTEM", operation: "FAIL", entity: "PostSchedule", entityId: stuck.id, before: { status: stuck.status }, after: { status: "FAILED", reconciliationRequired: true } });
      return updated.count;
    });
    reconciliationsNeeded += result;
  }
  if (scheduleId) {
    const claim = await db.postSchedule.updateMany({ where: { id: scheduleId, status: "QUEUED" }, data: { scheduledAt: new Date(), userUp: null } });
    if (!claim.count) return Response.json({ error: "Only approved queued posts can be triggered." }, { status: 409 });
  }
  const now = new Date();
  const candidates = await db.postSchedule.findMany({ where: { ...(scheduleId ? { id: scheduleId } : {}), status: "QUEUED", scheduledAt: { lte: now }, OR: [{ campaignSlotId: null }, { campaignSlot: { campaign: { status: { in: ["SCHEDULED", "ACTIVE"] } } } }] }, orderBy: { scheduledAt: "asc" }, take: scheduleId ? 1 : BATCH_SIZE, include: { product: true, account: true, contentVariant: { include: { draft: { select: { topicTag: true } } } }, campaignSlot: { include: { campaign: { select: { id: true, status: true } } } } } });
  const results: Array<{ scheduleId: string; status: "SUCCESS" | "FAILED" | "RETRYING" | "SCHEDULED"; error?: string; nextAttemptAt?: string }> = [];
  for (const candidate of candidates) {
    if (Date.now() - startedAt >= WORKER_BUDGET_MS) break;
    const claim = await db.postSchedule.updateMany({ where: { id: candidate.id, status: "QUEUED" }, data: { status: "GENERATING_AI", userUp: null } });
    if (!claim.count) continue;
    let captions: string[] = [];
    let imageUrl: string | null = null;
    let imageUrls: string[] = [];
    try {
      if (!candidate.account.isActive) throw new Error("Threads account is inactive. Activate it in Accounts before retrying.");
      const accountToken = await getThreadsAccountAccessToken(candidate.account.id);
      if (accountToken.expiresAt <= new Date()) throw new Error("Threads access token has expired and could not be refreshed. Reconnect the account in Accounts.");
      if (candidate.campaignSlot && !["SCHEDULED", "ACTIVE"].includes(candidate.campaignSlot.campaign.status)) throw new Error("Campaign is not active for publishing.");
      if (candidate.draftCaption) {
        captions = parseThreadPosts(candidate.draftThread, candidate.draftCaption).map((post) => post.text);
        imageUrls = parsePostImages(candidate.draftImageUrl);
        if (!imageUrls.length && candidate.product?.originalImages[0]) imageUrls = [candidate.product?.originalImages[0]];
      } else throw new Error("Draft tanpa caption memerlukan generasi AI, yang saat ini Coming Soon. Isi caption manual sebelum menerbitkan.");
      imageUrls = imageUrls.map(resolvePublishImageUrl).filter((image): image is string => Boolean(image));
      imageUrl = serializePostImages(imageUrls);
      await db.postSchedule.update({ where: { id: candidate.id }, data: { status: "PUBLISHING", userUp: null } });
      const publishThrough = candidate.threadDelayMinutes > 0 ? Math.min(captions.length, candidate.publishedThreadIds.length + 1) : captions.length;
      const postIds = await publishThreadSequence(candidate.account.threadsUserId, accountToken.accessToken, captions.slice(0, publishThrough), imageUrls, candidate.publishedThreadIds, async (ids) => {
        await db.postSchedule.update({ where: { id: candidate.id }, data: { publishedThreadIds: ids, userUp: null } });
      }, candidate.contentVariant?.topicTag);
      if (postIds.length < captions.length) {
        const nextAttemptAt = new Date(Date.now() + candidate.threadDelayMinutes * 60_000);
        await db.$transaction(async (tx) => {
          await tx.postSchedule.update({ where: { id: candidate.id }, data: { status: "QUEUED", scheduledAt: nextAttemptAt, userUp: null } });
          await tx.auditEvent.create({ data: { organizationId: candidate.organizationId, source: "WORKER", operation: "PUBLISH", entity: "PostSchedule", entityId: candidate.id, after: { status: "QUEUED", publishedCount: postIds.length, nextAttemptAt: nextAttemptAt.toISOString() } } });
        });
        try { await enqueuePostWorker(candidate.id, Math.round(candidate.threadDelayMinutes * 60)); }
        catch (error) { console.error("Failed to enqueue delayed thread continuation", { scheduleId: candidate.id, error: error instanceof Error ? error.message : "Unknown queue error" }); }
        results.push({ scheduleId: candidate.id, status: "SCHEDULED", nextAttemptAt: nextAttemptAt.toISOString() });
        continue;
      }
      const caption = captions.join("\n\n");
      await db.$transaction(async (tx) => {
        await tx.postLog.create({ data: { organizationId: candidate.organizationId, scheduleId: candidate.id, productId: candidate.productId, accountId: candidate.accountId, generatedCaption: caption, generatedImageUrl: imageUrl, threadsPostId: postIds[0], status: "SUCCESS" } });
        await tx.postSchedule.update({ where: { id: candidate.id }, data: { status: "SUCCESS", userUp: null } });
        await tx.auditEvent.create({ data: { organizationId: candidate.organizationId, source: "WORKER", operation: "PUBLISH", entity: "PostSchedule", entityId: candidate.id, after: { status: "SUCCESS", publishedCount: postIds.length } } });
        if (candidate.campaignSlotId && candidate.campaignSlot) {
          await tx.campaignSlot.update({ where: { id: candidate.campaignSlotId }, data: { status: "PUBLISHED" } });
          const remaining = await tx.campaignSlot.count({ where: { campaignId: candidate.campaignSlot.campaign.id, status: { notIn: ["PUBLISHED", "SKIPPED"] } } });
          await tx.campaign.update({ where: { id: candidate.campaignSlot.campaign.id }, data: { status: remaining ? "ACTIVE" : "COMPLETED" } });
        }
      });
      results.push({ scheduleId: candidate.id, status: "SUCCESS" });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unexpected worker error.";
      const caption = candidate.draftThread ? parseThreadPosts(candidate.draftThread, candidate.draftCaption || "").map((post) => post.text).join("\n\n") : candidate.draftCaption;
      const retrying = isRetryablePostError(error) && candidate.retryCount < MAX_AUTO_RETRIES;
      const retryCount = retrying ? candidate.retryCount + 1 : candidate.retryCount;
      const nextAttemptAt = retrying ? new Date(Date.now() + RETRY_DELAY_MINUTES[candidate.retryCount] * 60_000) : null;
      try {
        await db.$transaction(async (tx) => {
          await tx.postLog.create({ data: { organizationId: candidate.organizationId, scheduleId: candidate.id, productId: candidate.productId, accountId: candidate.accountId, generatedCaption: caption, generatedImageUrl: imageUrl, status: "FAILED", errorMessage } });
          await tx.postSchedule.update({ where: { id: candidate.id }, data: { status: retrying ? "QUEUED" : "FAILED", ...(nextAttemptAt ? { scheduledAt: nextAttemptAt } : {}), retryCount, userUp: null } });
          if (candidate.campaignSlotId) await tx.campaignSlot.update({ where: { id: candidate.campaignSlotId }, data: { status: retrying ? "QUEUED" : "FAILED" } });
          if (retrying && nextAttemptAt) await tx.postHistory.create({ data: { organizationId: candidate.organizationId, scheduleId: candidate.id, productId: candidate.productId, accountId: candidate.accountId, productTitle: candidate.product?.title || "Konten organik", accountName: candidate.account.accountName, eventType: "AUTO_RETRY", message: `${errorMessage} Retrying automatically (${retryCount} of ${MAX_AUTO_RETRIES}).`, caption, imageUrl, scheduledAt: nextAttemptAt } });
          await recordAuditEvent(tx, { actor: null, organizationId: candidate.organizationId, source: "WORKER", operation: retrying ? "RETRY" : "FAIL", entity: "PostSchedule", entityId: candidate.id, before: { status: "PUBLISHING", retryCount: candidate.retryCount }, after: { status: retrying ? "QUEUED" : "FAILED", retryCount, error: errorMessage.slice(0, 500) } });
        });
      } catch (persistError) { console.error("Failed to record post failure", candidate.id, persistError); }
      results.push({ scheduleId: candidate.id, status: retrying ? "RETRYING" : "FAILED", error: errorMessage, ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}) });
    }
  }
  let repliesPublished = 0;
  let nextReplyAt: Date | null = null;
  for (let depth = 0; depth < 100 && Date.now() - startedAt < WORKER_BUDGET_MS; depth += 1) {
    const pendingReplies = await db.postReply.findMany({
      where: { status: "PENDING", sourceSchedule: { status: "SUCCESS" }, OR: [{ parentReplyId: null }, { parentReply: { status: "PUBLISHED" } }] },
      include: { sourceSchedule: { select: { publishedThreadIds: true, logs: { where: { status: "SUCCESS" }, orderBy: { executedAt: "desc" }, take: 1, select: { executedAt: true } } } }, parentReply: { select: { publishedReplyId: true, publishedAt: true } }, account: { select: { id: true, threadsUserId: true, isActive: true } } },
      orderBy: [{ sourceScheduleId: "asc" }, { sequence: "asc" }], take: 20
    });
    if (!pendingReplies.length) break;
    let processedReadyReply = false;
    for (const reply of pendingReplies) {
      if (Date.now() - startedAt >= WORKER_BUDGET_MS) break;
      const replyToId = reply.parentReplyId ? reply.parentReply?.publishedReplyId : reply.sourceSchedule.publishedThreadIds[0];
      const parentPublishedAt = reply.parentReplyId ? reply.parentReply?.publishedAt : reply.sourceSchedule.logs[0]?.executedAt;
      const dueAt = parentPublishedAt ? new Date(parentPublishedAt.getTime() + reply.delayMinutes * 60_000) : new Date();
      if (dueAt > new Date()) {
        if (!nextReplyAt || dueAt < nextReplyAt) nextReplyAt = dueAt;
        continue;
      }
      processedReadyReply = true;
      if (!replyToId || !reply.account.isActive) {
        await db.postReply.updateMany({ where: { id: reply.id, status: "PENDING" }, data: { status: "FAILED", errorMessage: !replyToId ? "Post tujuan belum terbit atau reply sebelumnya gagal." : "Akun pengirim reply tidak aktif." } });
        continue;
      }
      const claimed = await db.postReply.updateMany({ where: { id: reply.id, status: "PENDING" }, data: { status: "PUBLISHING", errorMessage: null } });
      if (!claimed.count) continue;
      try {
        const accountToken = await getThreadsAccountAccessToken(reply.account.id);
        if (accountToken.expiresAt <= new Date()) throw new Error("Token akun reply sudah kedaluwarsa.");
        const publishedReplyId = await publishReplyToThreads(reply.account.threadsUserId, accountToken.accessToken, replyToId, reply.text);
        await db.postReply.update({ where: { id: reply.id }, data: { status: "PUBLISHED", publishedReplyId, publishedAt: new Date() } });
        repliesPublished += 1;
      } catch (error) {
        await db.postReply.update({ where: { id: reply.id }, data: { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Reply gagal diterbitkan." } });
      }
    }
    if (!processedReadyReply) break;
  }
  const readyReplyCount = await db.postReply.count({ where: { status: "PENDING", sourceSchedule: { status: "SUCCESS" }, OR: [{ parentReplyId: null }, { parentReply: { status: "PUBLISHED" } }] } });
  let replyContinuationQueued = false;
  if (readyReplyCount > 0) {
    const remainingSeconds = Date.now() - startedAt >= WORKER_BUDGET_MS - 5_000 || !nextReplyAt ? 0 : Math.max(1, Math.ceil((nextReplyAt.getTime() - Date.now()) / 1000));
    try { await enqueuePostWorkerContinuation(remainingSeconds); replyContinuationQueued = true; }
    catch (error) { console.error("Failed to enqueue reply continuation", { readyReplyCount, error: error instanceof Error ? error.message : "Unknown queue error" }); }
  }
  const durationMs = Date.now() - startedAt;
  console.info("post-worker completed", { durationMs, processed: results.length, repliesPublished, readyReplies: readyReplyCount, replyContinuationQueued, recovered, reconciliationsNeeded, tokensRefreshed, budgetExhausted: durationMs >= WORKER_BUDGET_MS });
  return Response.json({ processed: results.length, repliesPublished, readyReplies: readyReplyCount, replyContinuationQueued, recovered, reconciliationsNeeded, tokensRefreshed, durationMs, budgetExhausted: durationMs >= WORKER_BUDGET_MS, results });
}

export async function handleGet(request: Request) {
  return runWorker(request);
}

export async function handlePost(request: Request) {
  const body = await request.json().catch(() => ({})) as { scheduleId?: unknown };
  return runWorker(request, typeof body.scheduleId === "string" ? body.scheduleId : undefined);
}


