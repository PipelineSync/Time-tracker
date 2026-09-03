import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Build for the Chrome extension.
 *
 * Things that matter for MV3:
 *  - `target: 'esnext'` keeps the bundle free of downleveling helpers (no
 *    `eval` / `new Function`), which the extension CSP forbids.
 *  - The HTML entries live next to `manifest.json` so the manifest can point
 *    at `popup.html` / `options.html` directly.
 *  - `public/` (manifest + icons) is copied verbatim into the output.
 */
export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),
  css: {
    // The repository root has a Tailwind PostCSS config for the web app. The
    // extension styles are plain CSS, so skip it — otherwise the build fails
    // with "Cannot find module 'tailwindcss'" whenever the root dependencies
    // are not installed.
    postcss: { plugins: [] },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        popup: resolve(here, 'popup.html'),
        options: resolve(here, 'options.html'),
      },
      output: {
        format: 'es',
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
