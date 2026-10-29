/**
 * Org logos, served by Mittova itself so mail templates can show them.
 *
 * PNG only: it is what every mail client renders, and the dashboard converts
 * whatever was picked before uploading. Checking the signature also means the
 * public route can never be made to serve HTML from this origin.
 */
export const MAX_LOGO_BYTES = 512 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, or null when it is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Public path of a stored logo; the key's last segment is its hash. */
export function logoPath(orgId: string, key: string): string {
  return `/api/brand/${encodeURIComponent(orgId)}/logo/${key.split("/").pop()}`;
}

/**
 * The size to show it at in mail: uploads are kept at twice that for sharp
 * screens, then fitted inside 180 by 96: wide wordmarks stop at 180, and a
 * tall crest still gets enough height to be read.
 */
export function logoDisplaySize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(0.5, 180 / width, 96 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
