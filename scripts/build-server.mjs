#!/usr/bin/env node
/**
 * build-server.mjs
 * Compiles the Express server + all src/ modules into a single production bundle
 * using esbuild. Output: dist-server/server.cjs
 *
 * Why esbuild instead of tsc?
 *   - tsc with noEmit=true can't emit JS
 *   - tsx is a dev tool, not suitable for production
 *   - esbuild is 100x faster and produces a clean CJS bundle
 *
 * Why CJS (.cjs)?
 *   - better-sqlite3 is a native module that works best with CJS
 *   - Avoids ESM/CJS interop issues with native addons in production
 */

import { build } from "esbuild";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const __dirname = new URL(".", import.meta.url).pathname;
const root = resolve(__dirname, "..");

if (!existsSync(resolve(root, "dist-server"))) {
  mkdirSync(resolve(root, "dist-server"), { recursive: true });
}

console.log("Building server bundle...");

await build({
  entryPoints: [resolve(root, "server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: resolve(root, "dist-server/server.mjs"),
  // Externalize native modules and large packages that don't bundle well
  external: [
    "better-sqlite3",   // native addon — must be external
    "vite",             // dev-only, not used in production
    "esbuild",          // build tool, not runtime
    "@vitejs/*",        // dev-only
    "fsevents",         // macOS-only optional dep
  ],
  // Don't bundle node_modules for native addons
  packages: "external",
  // Source maps for production debugging
  sourcemap: true,
  // Minify for smaller bundle
  minify: false, // keep readable for debugging
  // Tree-shake dead code
  treeShaking: true,
  // Define production env
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
});

console.log("✓ Server bundle built: dist-server/server.mjs");
