export function parsePostImages(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((image) => typeof image === "string")) return parsed.filter(Boolean);
  } catch {
    // Older posts store a single image URL directly.
  }
  return [value];
}

export function serializePostImages(images: string[]): string | null {
  const clean = Array.from(new Set(images.map((image) => image.trim()).filter(Boolean)));
  return clean.length ? JSON.stringify(clean) : null;
}
