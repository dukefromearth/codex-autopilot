/**
 * Safe JSON parsing utilities.
 */

/**
 * Safely parse JSON, returning null on failure.
 * Attempts to extract JSON from prose-wrapped output.
 */
export function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try extracting JSON from prose
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    const slice = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      return null;
    }
  }
}

/**
 * Truncate text with head/tail preservation.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n...(truncated ${text.length - maxChars} chars)...\n\n${tail}`;
}
