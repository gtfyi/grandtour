const enc = new TextEncoder();

/**
 * URL slug from a human title: lowercase ASCII, hyphen-separated.
 * "Café de l'Église!" → "cafe-de-l-eglise". Never empty (falls back to "spot").
 */
export function slugify(s: string): string {
  const base = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "spot";
}

/**
 * Map a UTF-8 byte offset in `text` to the corresponding JS string index
 * (UTF-16 code units). Iterates by code point so surrogate pairs count
 * their true UTF-8 width. Offsets landing mid-character clamp forward to
 * the next character boundary. Offsets past the end return text.length.
 */
export function byteToStringIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let i = 0;
  for (const ch of text) {          // iterates by code point
    if (bytes >= byteOffset) return i;
    bytes += enc.encode(ch).length; // true UTF-8 width (1–4 bytes)
    i += ch.length;                 // 1 or 2 UTF-16 units
  }
  return text.length;
}
