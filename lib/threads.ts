import { db } from "./db.js";

type GraphResponse = { id?: string; access_token?: string; error?: { message?: string; code?: number; error_subcode?: number } };

const THREADS_PUBLISH_LOCK_ID = 7_314_219;
const THREADS_PUBLISH_MAX_SPACING_MS = 3_000;

async function withThreadsPublishSpacing<T>(operation: () => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${THREADS_PUBLISH_LOCK_ID})`;
    try {
      return await operation();
    } finally {
      const delayMs = Math.floor(Math.random() * (THREADS_PUBLISH_MAX_SPACING_MS + 1));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }, { maxWait: 10_000, timeout: 45_000 });
}

export type ThreadsProfile = { id: string; username?: string; name?: string; threads_profile_picture_url?: string; threads_biography?: string };

export async function refreshThreadsLongLivedToken(accessToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const url = new URL("https://graph.threads.net/refresh_access_token");
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", accessToken);
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" }); }
  catch { throw new Error("Tidak dapat terhubung ke Threads untuk memperbarui token."); }
  const data = await response.json().catch(() => ({})) as GraphResponse & { expires_in?: number };
  if (!response.ok || data.error || !data.access_token || !data.expires_in || data.expires_in <= 0) {
    throw new Error(data.error?.message || "Threads tidak dapat memperbarui token. Hubungkan ulang akun sebelum token kedaluwarsa.");
  }
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
}

export async function exchangeThreadsCode(code: string, redirectUri: string): Promise<{ accessToken: string; userId: string; expiresAt: Date; profile: ThreadsProfile }> {
  const appId = process.env.THREADS_APP_ID?.trim();
  const appSecret = process.env.THREADS_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error("Lengkapi THREADS_APP_ID dan THREADS_APP_SECRET di .env terlebih dahulu.");

  const exchange = async (params: URLSearchParams) => {
    let response: Response;
    try {
      response = await fetch("https://graph.threads.net/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
    } catch { throw new Error("Tidak dapat terhubung ke Threads. Periksa koneksi internet server lalu coba lagi."); }
    const rawBody = await response.text();
    let parsed: GraphResponse & { user_id?: string | number; expires_in?: number } = {};
    try { parsed = JSON.parse(rawBody) as typeof parsed; } catch { /* Handled by the response validation below. */ }
    // Meta may serialize large Threads user IDs as JSON numbers. Reading those
    // through JSON.parse first can round the final digits beyond MAX_SAFE_INTEGER.
    const rawUserIdMatch = rawBody.match(/"user_id"\s*:\s*(?:"(\d+)"|(\d+))/);
    const exactUserId = rawUserIdMatch?.[1] || rawUserIdMatch?.[2];
    const data = exactUserId ? { ...parsed, user_id: exactUserId } : parsed;
    if (!response.ok || data.error || !data.access_token) throw new Error(data.error?.message || "Threads tidak dapat menukar kode OAuth. Pastikan redirect URI sama persis dengan pengaturan aplikasi Meta.");
    return data;
  };

  const shortLived = await exchange(new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }));
  if (shortLived.user_id === undefined || shortLived.user_id === null || String(shortLived.user_id).trim() === "") throw new Error("Threads tidak mengembalikan ID pengguna untuk akun yang diotorisasi.");
  const authorizedUserId = String(shortLived.user_id);
  if (!shortLived.access_token) throw new Error("Threads tidak mengembalikan token akses untuk akun yang diotorisasi.");
  const shortLivedToken = shortLived.access_token;

  const longLivedUrl = new URL("https://graph.threads.net/access_token");
  longLivedUrl.searchParams.set("grant_type", "th_exchange_token");
  longLivedUrl.searchParams.set("client_secret", appSecret);
  longLivedUrl.searchParams.set("access_token", shortLivedToken);
  let longLivedResponse: Response;
  try { longLivedResponse = await fetch(longLivedUrl, { signal: AbortSignal.timeout(15_000), cache: "no-store" }); }
  catch { throw new Error("Kode berhasil ditukar, tetapi token jangka panjang gagal diminta. Coba hubungkan ulang akun."); }
  const longLived = await longLivedResponse.json().catch(() => ({})) as GraphResponse & { expires_in?: number };
  if (!longLivedResponse.ok || longLived.error || !longLived.access_token) throw new Error(longLived.error?.message || "Threads gagal menerbitkan token jangka panjang.");

  const profileUrl = new URL("https://graph.threads.net/v1.0/me");
  profileUrl.searchParams.set("fields", "id,username,name,threads_profile_picture_url,threads_biography");
  profileUrl.searchParams.set("access_token", longLived.access_token);
  const profile = await readThreadsJson(profileUrl);
  if (!profile.id || String(profile.id) !== authorizedUserId) throw new Error("ID profil Threads tidak cocok dengan akun yang memberi izin.");
  const expiresIn = longLived.expires_in || 5_184_000;
  return { accessToken: longLived.access_token, userId: authorizedUserId, expiresAt: new Date(Date.now() + expiresIn * 1000), profile: { id: authorizedUserId, username: profile.username, name: profile.name, threads_profile_picture_url: profile.threads_profile_picture_url, threads_biography: profile.threads_biography } };
}

class ThreadsRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ThreadsRequestError";
  }
}

async function readThreadsJson(url: URL): Promise<GraphResponse & { username?: string; name?: string; threads_profile_picture_url?: string; threads_biography?: string; data?: { app_id?: string; is_valid?: boolean; scopes?: string[]; granular_scopes?: Array<{ scope?: string }> } }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const detail = [error instanceof Error ? error.message : "Permintaan gagal", cause instanceof Error ? cause.message : ""]
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(": ");
    throw new Error(`Server tidak dapat terhubung ke Threads API melalui HTTPS. Pastikan koneksi keluar ke graph.threads.net:443 diizinkan. Detail: ${detail}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const code = data.error?.code;
    if (code === 190) throw new Error("Token Threads kedaluwarsa atau tidak valid. Perbarui token di menu Accounts.");
    throw new Error("Meta menolak pemeriksaan token. Periksa Threads App ID, App Secret, dan token yang dimasukkan.");
  }
  return data;
}

export async function verifyThreadsIdentity(expectedUserId: string, accessToken: string): Promise<{ id: string; username?: string; name?: string; profilePictureUrl?: string; biography?: string; scopes: string[] }> {
  const appId = process.env.THREADS_APP_ID?.trim();
  const appSecret = process.env.THREADS_APP_SECRET?.trim();
  if (!appId || !appSecret) throw new Error("Lengkapi THREADS_APP_ID dan THREADS_APP_SECRET di .env, lalu restart aplikasi agar izin publish dapat diverifikasi.");
    const url = new URL("https://graph.threads.net/v1.0/me");
    url.searchParams.set("fields", "id,username,name,threads_profile_picture_url,threads_biography");
    url.searchParams.set("access_token", accessToken);
    const profile = await readThreadsJson(url);
    if (!profile.id) throw new Error("Token tidak dapat membaca profil Threads. Pastikan token memiliki izin threads_basic.");
    if (profile.id !== expectedUserId) {
      throw new Error(`Threads User ID tidak cocok. ID yang disimpan (${expectedUserId}) berbeda dari ID profil token ini (${profile.id}${profile.username ? ` @${profile.username}` : ""}). Isi Threads User ID dengan ID profil yang dikembalikan oleh GET /me?fields=id,username, bukan ID aplikasi.`);
    }

    const appTokenUrl = new URL("https://graph.threads.net/oauth/access_token");
    appTokenUrl.searchParams.set("grant_type", "client_credentials");
    appTokenUrl.searchParams.set("client_id", appId);
    appTokenUrl.searchParams.set("client_secret", appSecret);
    const appToken = await readThreadsJson(appTokenUrl);
    if (!appToken.access_token) throw new Error("Meta tidak mengembalikan app access token. Periksa Threads App ID dan App Secret.");

    const debugUrl = new URL("https://graph.threads.net/debug_token");
    debugUrl.searchParams.set("input_token", accessToken);
    debugUrl.searchParams.set("access_token", appToken.access_token);
    const debug = await readThreadsJson(debugUrl);
    if (!debug.data?.is_valid) throw new Error("Access token Threads tidak aktif. Buat token baru lalu coba lagi.");
    if (debug.data.app_id && debug.data.app_id !== appId) throw new Error("Token ini dibuat untuk Threads App ID yang berbeda. Buat token menggunakan aplikasi Meta yang dikonfigurasi di .env.");
    const permissions = new Set([...(debug.data.scopes || []), ...(debug.data.granular_scopes || []).map((scope) => scope.scope || "")]);
    const missing = ["threads_basic", "threads_content_publish"].filter((permission) => !permissions.has(permission));
    if (missing.length) throw new Error(`Token belum memiliki izin ${missing.join(" dan ")}. Tambahkan izin tersebut di aplikasi Meta, lalu buat ulang access token.`);
    return { id: profile.id, username: profile.username, name: profile.name, profilePictureUrl: profile.threads_profile_picture_url, biography: profile.threads_biography, scopes: [...permissions] };
}

async function graphPost(path: string, body: URLSearchParams, stage: "container" | "publish"): Promise<GraphResponse> {
  let response: Response;
  try {
    response = await fetch(`https://graph.threads.net/v1.0/${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20_000), cache: "no-store" });
  } catch (error) {
    const message = `Threads network error: ${error instanceof Error ? error.message : "request failed"}`;
    // A lost publish response may mean Threads already published the post; never retry it automatically.
    throw new ThreadsRequestError(message, stage === "container");
  }
  const data = await response.json().catch(() => ({})) as GraphResponse;
  if (!response.ok || data.error) {
    const code = data.error?.code;
    const rateLimited = response.status === 429 || code === 4 || code === 17;
    const temporaryCreateError = stage === "container" && (response.status >= 500 || code === 1 || code === 2);
    const reason = code === 190 ? "Threads access token is expired or invalid. Update the token in Accounts." : rateLimited ? "Threads rate limit reached; the post will be retried automatically." : code === 100 ? "Threads could not find this profile ID or the token cannot publish to it. In Accounts, verify the Threads User ID using GET /me?fields=id,username with this account's token. Do not enter the Threads app ID. Also confirm the token includes threads_content_publish." : data.error?.message || `Threads API returned HTTP ${response.status}.`;
    throw new ThreadsRequestError(reason, rateLimited || temporaryCreateError);
  }
  return data;
}

async function publishToThreadsUnlocked(userId: string, accessToken: string, text: string, imageInput?: string[] | string | null, topicTag?: string | null): Promise<string> {
  const imageUrls = Array.from(new Set((Array.isArray(imageInput) ? imageInput : imageInput ? [imageInput] : []).filter(Boolean)));
  const normalizedTopicTag = topicTag?.trim().replace(/^#/, "").trim();
  if (normalizedTopicTag && normalizedTopicTag.length > 50) throw new Error("Threads topic tags support up to 50 characters.");
  if (imageUrls.length > 20) throw new Error("Threads carousel posts support up to 20 photos.");
  for (const imageUrl of imageUrls) {
    let parsed: URL;
    try { parsed = new URL(imageUrl); } catch { throw new Error("Threads image URL must be a public HTTPS URL."); }
    if (parsed.protocol !== "https:") throw new Error("Threads image URL must use HTTPS.");
  }
  const createBody = new URLSearchParams({ media_type: imageUrls.length > 1 ? "CAROUSEL" : imageUrls.length === 1 ? "IMAGE" : "TEXT", text, access_token: accessToken });
  if (normalizedTopicTag) createBody.set("topic_tag", normalizedTopicTag);
  if (imageUrls.length === 1) createBody.set("image_url", imageUrls[0]);
  if (imageUrls.length > 1) {
    const childIds: string[] = [];
    for (const imageUrl of imageUrls) {
      const child = await graphPost(`${encodeURIComponent(userId)}/threads`, new URLSearchParams({ media_type: "IMAGE", image_url: imageUrl, is_carousel_item: "true", access_token: accessToken }), "container");
      if (!child.id) throw new Error("Threads did not return a carousel image container ID.");
      childIds.push(child.id);
    }
    createBody.set("children", childIds.join(","));
  }
  const container = await graphPost(`${encodeURIComponent(userId)}/threads`, createBody, "container");
  if (!container.id) throw new Error("Threads did not return a media container ID.");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const publishBody = new URLSearchParams({ creation_id: container.id, access_token: accessToken });
  const published = await graphPost(`${encodeURIComponent(userId)}/threads_publish`, publishBody, "publish");
  if (!published.id) throw new Error("Threads did not return a post ID.");
  return published.id;
}

export async function publishToThreads(userId: string, accessToken: string, text: string, imageInput?: string[] | string | null, topicTag?: string | null): Promise<string> {
  return withThreadsPublishSpacing(() => publishToThreadsUnlocked(userId, accessToken, text, imageInput, topicTag));
}

async function publishReplyToThreadsUnlocked(userId: string, accessToken: string, replyToId: string, text: string): Promise<string> {
  const container = await graphPost(`${encodeURIComponent(userId)}/threads`, new URLSearchParams({ media_type: "TEXT", text, reply_to_id: replyToId, access_token: accessToken }), "container");
  if (!container.id) throw new Error("Threads tidak mengembalikan ID kontainer balasan.");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const published = await graphPost(`${encodeURIComponent(userId)}/threads_publish`, new URLSearchParams({ creation_id: container.id, access_token: accessToken }), "publish");
  if (!published.id) throw new Error("Threads tidak mengembalikan ID balasan yang diterbitkan.");
  return published.id;
}

export async function publishReplyToThreads(userId: string, accessToken: string, replyToId: string, text: string): Promise<string> {
  return withThreadsPublishSpacing(() => publishReplyToThreadsUnlocked(userId, accessToken, replyToId, text));
}

export async function deleteThreadsPost(postId: string, accessToken: string): Promise<void> {
  const url = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(postId)}`);
  url.searchParams.set("access_token", accessToken);
  let response: Response;
  try {
    response = await fetch(url, { method: "DELETE", signal: AbortSignal.timeout(20_000), cache: "no-store" });
  } catch {
    throw new Error("Tidak dapat terhubung ke Threads untuk menghapus post.");
  }
  const data = await response.json().catch(() => ({})) as GraphResponse & { success?: boolean };
  // A retry can encounter a post that was removed by an earlier partial request.
  if (data.error?.code === 100) return;
  if (!response.ok || data.error || data.success !== true) {
    const code = data.error?.code;
    const reason = code === 190
      ? "Token Threads kedaluwarsa atau tidak valid. Hubungkan ulang akun."
      : code === 10 || code === 200
        ? "Token belum memiliki izin threads_delete. Hubungkan ulang akun dan berikan izin hapus post."
        : data.error?.message || `Threads gagal menghapus post (HTTP ${response.status}).`;
    throw new Error(reason);
  }
}

export async function publishThreadSequence(userId: string, accessToken: string, texts: string[], imageUrls: string[] | string | null, alreadyPublished: string[], onPublished: (ids: string[]) => Promise<void>, topicTag?: string | null): Promise<string[]> {
  const publishedIds = [...alreadyPublished];
  for (let index = publishedIds.length; index < texts.length; index++) {
    if (index === 0) {
      publishedIds.push(await publishToThreads(userId, accessToken, texts[index], imageUrls, topicTag));
    } else {
      const replyId = await withThreadsPublishSpacing(async () => {
        const body = new URLSearchParams({ media_type: "TEXT", text: texts[index], reply_to_id: publishedIds[index - 1], access_token: accessToken });
        const container = await graphPost(`${encodeURIComponent(userId)}/threads`, body, "container");
        if (!container.id) throw new Error("Threads did not return a reply container ID.");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const publishBody = new URLSearchParams({ creation_id: container.id, access_token: accessToken });
        const published = await graphPost(`${encodeURIComponent(userId)}/threads_publish`, publishBody, "publish");
        if (!published.id) throw new Error("Threads did not return a reply post ID.");
        return published.id;
      });
      publishedIds.push(replyId);
    }
    await onPublished([...publishedIds]);
  }
  return publishedIds;
}

