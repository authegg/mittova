/**
 * Screenshot pipeline.
 *
 * The eleven PNGs in `../assets/` are shared with the README and are the
 * canonical copies — nothing here writes to that directory, and nothing copies
 * a PNG into `site/`. Each one is read, resized and re-encoded into AVIF, WebP
 * and a modestly sized PNG fallback, which are emitted straight into the bundle
 * as build artifacts.
 *
 * The originals are 3040px wide and 130–530 KB. The page never displays one
 * wider than ~1120 CSS pixels, so shipping them untouched would be sending
 * roughly ten times the bytes anybody needs.
 *
 * Encoding is expensive — AVIF especially — so results are cached under
 * node_modules/.cache, keyed by the source's size and mtime. A warm build does
 * no image work at all.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));

/** Shared with the README. Read-only, always. */
export const ASSETS = join(here, "..", "..", "assets");

const CACHE = join(here, "..", "node_modules", ".cache", "mittova-site-images");

/**
 * Rendered widths. The page column caps at 1120px, so 1280 covers a 1x desktop
 * and 2048 covers a 2x one; 768 is for phones. Nothing needs the full 3040.
 */
const WIDTHS = [768, 1280, 2048] as const;

/** The PNG is only ever fetched by a browser that understands neither AVIF nor
 *  WebP, so it is sized for legibility rather than for a retina display. */
const FALLBACK_WIDTH = 1280;

export type Shot = {
  /** Token used in index.html, and the stem of the emitted filenames. */
  id: string;
  /** Basenames in ../assets, minus the extension. */
  light: string;
  dark: string;
};

/**
 * Every screenshot the page shows. `social-preview.png` is deliberately absent:
 * it is the GitHub card, not page content.
 */
export const SHOTS: Shot[] = [
  { id: "inbox", light: "screenshot-light", dark: "screenshot-dark" },
  { id: "message", light: "message-light", dark: "message-dark" },
  { id: "users", light: "users-light", dark: "users-dark" },
  { id: "templates", light: "templates-light", dark: "templates-dark" },
  { id: "keys", light: "keys-light", dark: "keys-dark" },
];

export type Variant = {
  fileName: string;
  source: Buffer;
  width: number;
  format: "avif" | "webp" | "png";
};

export type Rendered = {
  /** Intrinsic size of the original, for the img's width/height attributes. */
  width: number;
  height: number;
  variants: Variant[];
};

function cached(key: string, produce: () => Promise<Buffer>): Promise<Buffer> {
  const path = join(CACHE, key);
  try {
    return Promise.resolve(readFileSync(path));
  } catch {
    return produce().then((buf) => {
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(path, buf);
      return buf;
    });
  }
}

/** Cheap identity for a source file: a changed screenshot changes its stat. */
function stamp(path: string): string {
  const s = statSync(path);
  return createHash("sha1").update(`${path}:${s.size}:${s.mtimeMs}`).digest("hex").slice(0, 12);
}

async function encode(src: string, width: number, format: Variant["format"]): Promise<Buffer> {
  const pipeline = sharp(src).resize({ width, withoutEnlargement: true });
  if (format === "avif") return pipeline.avif({ quality: 58, effort: 5 }).toBuffer();
  if (format === "webp") return pipeline.webp({ quality: 80, effort: 5 }).toBuffer();
  // The fallback path. Screenshots are flat UI, so a palette quantises them
  // well below what a truecolour PNG would cost.
  return pipeline.png({ compressionLevel: 9, palette: true, quality: 88 }).toBuffer();
}

/** Resize and re-encode one source PNG into every variant the page can use. */
export async function render(basename: string): Promise<Rendered> {
  const src = join(ASSETS, `${basename}.png`);
  const meta = await sharp(src).metadata();
  const id = stamp(src);

  const wanted: Array<{ width: number; format: Variant["format"] }> = [
    ...WIDTHS.flatMap((width) => [
      { width, format: "avif" as const },
      { width, format: "webp" as const },
    ]),
    { width: FALLBACK_WIDTH, format: "png" as const },
  ];

  const variants: Variant[] = [];
  for (const { width, format } of wanted) {
    const key = `${basename}.${id}.${width}.${format}`;
    const source = await cached(key, () => encode(src, width, format));
    variants.push({
      fileName: `img/${basename}-${width}.${id.slice(0, 8)}.${format}`,
      source,
      width,
      format,
    });
  }

  return { width: meta.width ?? 0, height: meta.height ?? 0, variants };
}

export function srcset(variants: Variant[], format: Variant["format"]): string {
  return variants
    .filter((v) => v.format === format)
    .map((v) => `/${v.fileName} ${v.width}w`)
    .join(", ");
}

export function fallback(variants: Variant[]): Variant {
  const png = variants.find((v) => v.format === "png");
  if (!png) throw new Error("no PNG fallback was rendered");
  return png;
}
