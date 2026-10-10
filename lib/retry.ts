export class TransientPostError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "TransientPostError";
  }
}

export function isRetryablePostError(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|temporarily unavailable|high demand|rate.?limit|fetch failed|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/i.test(message);
}

export function isSafeHistoricalRetry(errorMessage: string): boolean {
  // Old failures lack a recorded execution stage. Retry only errors identifiable as Gemini/service-capacity failures;
  // a past Threads publish timeout could already have created a public post.
  return /gemini|generativelanguage\.googleapis\.com|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|temporarily unavailable|\b429\b|rate.?limit/i.test(errorMessage);
}
