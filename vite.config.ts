import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// PipelineSync brand navy — used for the PWA splash / install chrome so the
// installed app opens on the same colour as the native splash screens.
const NAVY = '#06245B'

export default defineConfig({
  plugins: [
    react(),
    // Progressive Web App: makes the site installable as a real app on
    // iPhone (Safari → Add to Home Screen), Android (Play-Store-style install
    // prompt) and desktop Chrome/Edge, with an offline-capable app shell.
    // Native shells (Capacitor iOS/Android, Tauri desktop) skip the service
    // worker at runtime — see src/main.tsx — so it never fights the OS caches.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon.png', 'pwa/apple-touch-icon.png'],
      manifest: {
        name: 'PipelineSync Work Tracker',
        short_name: 'PipelineSync',
        description:
          'Track worker hours, breaks, notes and payments. Clock in/out, settle earnings and chat with your team.',
        id: '/',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'portrait-primary',
        background_color: NAVY,
        theme_color: NAVY,
        categories: ['business', 'productivity'],
        icons: [
          {
            src: '/pwa/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/pwa/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Clock In / Out',
            short_name: 'Clock',
            description: 'Open the worker clock',
            url: '/tracker',
            icons: [{ src: '/pwa/pwa-192.png', sizes: '192x192' }],
          },
          {
            name: 'Time Entries',
            short_name: 'Entries',
            description: 'Review recorded time',
            url: '/entries',
            icons: [{ src: '/pwa/pwa-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Recharts (~110 KB gzipped) is only ever loaded by the admin Reports
        // page, but precaching pushes it to EVERY install — including every
        // worker's phone, on every new deploy. Excluding it from the precache
        // keeps the install small; admins still get it on first visit to
        // Reports and it is then cached at runtime by the rule below.
        globIgnores: [
          '**/charts-*.js',
          // The Claude Connector's sign-in logo. Only ever requested by the
          // connector page (a Netlify Function response), so precaching it
          // would put it on every worker's phone for nothing.
          '**/brand/pipelinesync-icon-128.png',
        ],
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        // Never answer a navigation from the cached app shell when it has to
        // reach the network instead:
        //
        //  - /netlify/*, /.netlify/*: Netlify's own paths.
        //  - /oauth/*, /mcp, /mcp-status, /.well-known/*: the Claude Connector.
        //
        // The connector routes are the ones a real browser navigates to:
        // Claude opens /oauth/authorize in a tab so the user can sign in, and
        // netlify.toml rewrites it to the oauth-authorize function. Once this
        // site's service worker was installed, that navigation was answered
        // from the precached shell, React Router rendered the web app's own
        // login page instead of the connector's sign-in card, and signing in
        // merely opened the dashboard — Claude never received an authorization
        // code. Denying these paths keeps them network-only. The app still
        // gets the shell on every other route.
        navigateFallbackDenylist: [
          /^\/netlify\//,
          /^\/\.netlify\//,
          /^\/oauth\//,
          /^\/mcp(-status)?\/?$/,
          /^\/\.well-known\//,
        ],
        // NOTE: Supabase requests are deliberately NOT cached. Responses are
        // scoped per signed-in user by RLS, so a URL-keyed cache could leak
        // one account's data to another account on a shared device. The app
        // shell + assets are fully offline-capable; live data needs network.
        // Inter is self-hosted (@fontsource, see src/main.tsx) — its files
        // are fingerprinted build output, so the precache + /assets/*
        // immutable headers cover them; no external font caching needed.
        runtimeCaching: [
          {
            // Lazily-loaded, fingerprinted JS chunks that are deliberately
            // kept out of the precache (currently the charts bundle). Cached
            // on first use, so an admin downloads Reports' chart library once
            // rather than on every deploy.
            urlPattern: ({ request, url }) =>
              request.destination === 'script' &&
              url.origin === self.location.origin &&
              /\/assets\/charts-.*\.js$/.test(url.pathname),
            handler: 'CacheFirst',
            method: 'GET',
            options: {
              cacheName: 'lazy-chunks',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Same-origin images (brand assets, icons) — safe to cache.
            urlPattern: ({ request, url }) =>
              request.destination === 'image' && url.origin === self.location.origin,
            handler: 'CacheFirst',
            method: 'GET',
            options: {
              cacheName: 'same-origin-images',
              expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // Keep the dev server free of a service worker (HMR stays predictable);
      // the PWA is exercised against production builds via `npm run preview`.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow the sandboxed preview host and any custom domain to connect.
    allowedHosts: true,
  },
  build: {
    rollupOptions: {
      output: {
        // Stable vendor chunks: framework and Supabase change rarely, so
        // browsers keep reusing them from cache across deploys instead of
        // re-downloading the whole app bundle.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
          // Recharts is by far the heaviest dependency (~110 KB gzipped) and
          // is used only by the admin Reports page. Pinning it to its own
          // chunk means (a) nobody else ever downloads it, and (b) it keeps a
          // stable URL across deploys, so admins re-use it from cache instead
          // of re-downloading it whenever unrelated app code changes.
          charts: ['recharts'],
        },
      },
    },
  },
})
