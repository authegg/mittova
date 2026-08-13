import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import * as comparison from "./build/comparison.ts";
import { ASSETS, SHOTS, fallback, render, srcset, type Rendered } from "./build/images.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The page column is 1120px wide inside 24px of padding, so below 1168px the
 * image is the viewport minus the gutters and above it the image is fixed.
 */
const SIZES = "(min-width: 1168px) 1120px, calc(100vw - 48px)";

/**
 * Renders the comparison table from the canonical JSON.
 *
 * The table is written into `<div data-comparison></div>`, and if that hook is
 * missing the build fails rather than quietly shipping a page with a hole in
 * it.
 */
function comparisonTable(): Plugin {
  return {
    name: "mittova:comparison",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const hook = /<div data-comparison><\/div>/;
        if (!hook.test(html)) throw new Error("index.html has no <div data-comparison></div>");
        return html.replace(hook, comparison.render(comparison.read()));
      },
    },
  };
}

/**
 * Fills in every `<picture data-shot="…">` from the shared `../assets`
 * screenshots, and emits the resized AVIF/WebP/PNG variants into the bundle.
 *
 * The light and dark plates are selected by `prefers-color-scheme` on the
 * <source> elements, which is what makes the page correct with JavaScript
 * turned off. Only the matching plate is ever fetched — a browser downloads one
 * source per <picture>, not all of them. The theme toggle rewrites those media
 * queries when it runs, so the screenshots follow a pinned theme too.
 */
function screenshots(): Plugin {
  const rendered = new Map<string, Rendered>();
  let ready: Promise<void> | undefined;
  let building = false;

  const prepare = () =>
    (ready ??= (async () => {
      for (const shot of SHOTS) {
        for (const basename of [shot.light, shot.dark]) {
          rendered.set(basename, await render(basename));
        }
      }
    })());

  /** One themed pair of <source> elements plus the shared <img> fallback. */
  function picture(id: string, alt: string, eager: boolean): string {
    const shot = SHOTS.find((s) => s.id === id);
    if (!shot) throw new Error(`index.html asks for unknown screenshot "${id}"`);

    const light = rendered.get(shot.light)!;
    const dark = rendered.get(shot.dark)!;
    const png = fallback(light.variants);

    const sources = (r: Rendered, scheme: "light" | "dark") =>
      (["avif", "webp"] as const)
        .map(
          (format) =>
            `<source data-scheme="${scheme}" media="(prefers-color-scheme: ${scheme})" type="image/${format}" srcset="${srcset(r.variants, format)}" sizes="${SIZES}">`,
        )
        .join("\n            ");

    // Dark first: a <picture> takes the first source whose media matches, and a
    // browser with no stated preference reports "light", so the light pair is
    // the natural default and belongs last.
    return `<picture>
            ${sources(dark, "dark")}
            ${sources(light, "light")}
            <img src="/${png.fileName}" width="${light.width}" height="${light.height}" alt="${alt}"
              ${eager ? 'fetchpriority="high" decoding="sync"' : 'loading="lazy" decoding="async"'}>
          </picture>`;
  }

  return {
    name: "mittova:screenshots",

    configResolved(config) {
      building = config.command === "build";
    },

    async buildStart() {
      await prepare();
      if (!building) return;
      for (const r of rendered.values()) {
        for (const v of r.variants) {
          this.emitFile({ type: "asset", fileName: v.fileName, source: v.source });
        }
      }
    },

    // In dev there is no bundle to emit into, so the same buffers are served
    // from memory on the same paths the built page uses.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        if (!path.startsWith("img/")) return next();
        const promise = prepare().then(() => {
          for (const r of rendered.values()) {
            const hit = r.variants.find((v) => v.fileName === path);
            if (!hit) continue;
            res.setHeader("Content-Type", `image/${hit.format}`);
            res.end(hit.source);
            return;
          }
          next();
        });
        // Without this a rejection from prepare() — a missing or corrupt PNG in
        // assets/ — never responds and never calls next(), so the request hangs
        // until the browser gives up and the only clue is an unhandled rejection
        // in the terminal. Every other failure path in these plugins throws
        // loudly; this one should too.
        promise.catch(next);
      });
    },

    transformIndexHtml: {
      order: "post",
      async handler(html) {
        await prepare();

        // Attributes are matched loosely because index.html is formatted by
        // Prettier, which is free to break a long `data-alt` onto its own line.
        const out = html.replace(/<picture\s([^>]*?)\s*><\/picture>/g, (whole, attrs: string) => {
          const id = /data-shot="([^"]*)"/.exec(attrs)?.[1];
          const alt = /data-alt="([^"]*)"/.exec(attrs)?.[1];
          if (!id || alt === undefined) {
            throw new Error(`<picture> without data-shot and data-alt: ${whole}`);
          }
          if (!alt.trim()) throw new Error(`screenshot "${id}" has empty alt text`);
          return picture(id, alt, /\bdata-eager\b/.test(attrs));
        });

        // An earlier version of this regex did not allow newlines inside the
        // tag, so every screenshot quietly rendered as an empty <picture> and
        // the page shipped with no images at all. Never fail quietly again.
        if (/data-shot=/.test(out)) throw new Error("a <picture data-shot> was left unrendered");
        return out;
      },
    },
  };
}

/**
 * Inlines the theme script into the <head>.
 *
 * It has to run before the first paint — a deferred module would let a pinned
 * dark page flash light — and it is small enough that a separate request would
 * cost more than the bytes. It is the only script on the page.
 */
function themeScript(): Plugin {
  return {
    name: "mittova:theme",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const js = readFileSync(join(here, "src", "theme.js"), "utf8");
        const hook = /<script data-theme-script><\/script>/;
        if (!hook.test(html)) throw new Error("index.html has no <script data-theme-script>");
        return html.replace(hook, `<script>${js}</script>`);
      },
    },
  };
}

export default defineConfig({
  plugins: [comparisonTable(), screenshots(), themeScript()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One stylesheet and one font; the extra directory just deepens the paths.
    assetsDir: "a",
  },
  server: {
    // The screenshots live in ../assets, shared with the README, and are read
    // through the plugin above rather than copied in here.
    fs: { allow: [here, ASSETS] },
  },
});
