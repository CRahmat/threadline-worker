export type ThreadPost = { text: string };

export function parseThreadPosts(value: string | null | undefined, fallback = ""): ThreadPost[] {
  if (!value) return fallback ? [{ text: fallback }] : [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const posts = parsed.filter((item): item is ThreadPost => Boolean(item && typeof item === "object" && "text" in item && typeof item.text === "string" && item.text.trim()));
      if (posts.length) return posts.map((post) => ({ text: post.text.trim() }));
    }
  } catch {
    // Older schedules stored a single plain caption.
  }
  return [{ text: value.trim() || fallback }].filter((post) => post.text.length > 0);
}

export function serializeThreadPosts(posts: ThreadPost[]): string {
  return JSON.stringify(posts.map(({ text }) => ({ text: text.trim() })));
}
