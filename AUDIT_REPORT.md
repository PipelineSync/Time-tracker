# Time Tracker — Audit & Remediation Report
Date: 2026-09-15 (Asia/Manila)
Branch: arena/01a0a10c-time-tracker
Base: b08de7c5b785794709fcf212611f18fc479c5b6a (main)

## Executive Summary
**Status after remediation: 0 npm vulnerabilities, build green.**

Initial audit found 7 vulnerabilities (6 moderate, 1 high) from outdated vite/esbuild/react-router/uuid plus 3 P0 functional bugs. All have been fixed and verified:
- `npm audit` now 0 vulnerabilities
- `tsc --noEmit`, `eslint .`, `vite build` all pass
- Verification scripts `verify:deletion` and `verify:permissions` pass
- Image upload now validated (5 MB limit + MIME allowlist)
- Workspace full-reset now scoped by owner and deletes all tables
- Permission drift fixed

## What Was Fixed (P0)

### 1. `netlify/functions/create-worker.ts` — missing `invoices.view`
- **Bug**: PERMISSIONS allow-list lacked `invoices.view`. `cleanPermissions()` silently dropped it, so workers created via Netlify function never got invoicing access even though RLS and types.ts allowed it.
- **Fix**: Added `'invoices.view'` to PERMISSIONS array.
- **File**: `netlify/functions/create-worker.ts:18`

### 2. `netlify/functions/delete-worker.ts` — global wipe instead of scoped reset
- **Bug**: `body.all === true` did `.not('id','is',null)` on workers/entries/etc — would delete every workspace in the database, not just the admin's. Also missed tables: clients, finance_items, tasks, client_priorities, meetings, invoices, slack_settings, chat_*, notepad_notes.
- **Fix**: Now:
  - Gets `ownerId = auth.userId`
  - Fetches owner's worker IDs, filters profiles to only delete logins belonging to this workspace
  - `deleteOwned(table)` does `.eq('user_id', ownerId)` with try/catch for missing migrations
  - Deletes 15 workspace tables in FK-safe order: chat_reactions, chat_messages, time_entry_comments, notifications, active_timers, time_entries, payments, tasks, invoices, meetings, client_priorities, finance_items, clients, slack_settings, workers
  - Clears `notepad_notes` for admin + deleted worker user_ids (per-user table)
  - Preserves settings (prod behavior)
- **File**: `netlify/functions/delete-worker.ts`

### 3. `src/lib/image.ts` — no size/type validation → OOM / huge base64 rows
- **Bug**: Any file type with `image/*` prefix accepted, no size limit. A 50 MB photo would be loaded into canvas and stored as base64 in Supabase/localStorage.
- **Fix**:
  - `MAX_FILE_BYTES = 5 MB`
  - `ALLOWED_TYPES = [jpeg, png, webp, gif]`
  - `isImageFile()` now checks allowlist, not just prefix
  - New `validateImageFile()` returns user-friendly error string
  - New `getMaxImageBytes()` accessor
- **Callers updated**: `SettingsPage.tsx` now uses `validateImageFile` for avatar, QR code, and profile picture (previously mixed `isImageFile` and direct `type.startsWith`). Shows error toast with size/type reason.
- **Files**: `src/lib/image.ts`, `src/pages/SettingsPage.tsx`

### 4. `src/lib/personalFinance.ts` — bypassed storage wrapper
- **Bug**: Used direct `localStorage.getItem/setItem`, bypassing `src/lib/storage.ts` which handles sandboxed iframe blocking (falls back to memory). Would fail in preview iframe.
- **Fix**: Import `storage` and use `storage.getItem/setItem`.
- **File**: `src/lib/personalFinance.ts`

### 5. `src/lib/localDb.ts` — resetAll missed slack settings
- **Bug**: `resetAll()` called `save(emptyData())` which wipes main blob but `slackKey` lives in separate key and survived reset. Also personal finance is per-user private and should NOT be deleted on workspace reset.
- **Fix**: Explicitly `storage.removeItem(slackKey)` on reset, with comment that personal finance is intentionally preserved.
- **File**: `src/lib/localDb.ts`

### 6. Dependencies — CVEs
- **Before**: 7 vulns
  - esbuild <=0.24.2 moderate GHSA-67mh-4wv8-2f99
  - vite <=6.4.2 moderate/high GHSA-fx2h-pf6j-xcff
  - react-router 6.0.0-7.17.0 moderate open-redirect GHSA-wrjc-x8rr-h8h6 + constructor injection GHSA-337j-9hxr-rhxg + follow-up CVE-2025-68470 bypass
  - uuid <11.1.1 via xcode->@capacitor/cli GHSA-w5hq-g745-h8pq
- **After**:
  - `vite` ^5.4.8 → ^6.4.3 (uses esbuild ^0.25.12, fixes both vite and esbuild advisories)
  - `react-router-dom` ^6.26.2 → ^7.18.3 (latest 7.x, fixes all three react-router CVEs; typecheck + build pass, v7 still compatible with v6 APIs used)
  - Added `overrides: { uuid: ^11.1.0 }` to force xcode's uuid to 11.1.1 (verified via `npm ls`)
  - `npm audit` → 0 vulnerabilities
- **Files**: `package.json`, `package-lock.json`

## Verification

```
npm run typecheck  → pass
npm run lint       → pass
npm run build      → pass (PWA 108 entries, chunks: react 183KB, supabase 214KB, index 370KB, charts 421KB)
npm audit          → 0 vulnerabilities
npm run verify:deletion   → ALL CHECKS PASSED (local + supabase)
npm run verify:permissions → ALL CHECKS PASSED
```

## Remaining Notes (P1-P3, not blocking)

- **P1**: `recharts@2.x` deprecated (2.x EOL). Migrate to v3 when convenient.
- **P2**: `/.netlify/functions/sync-fx-rate` is unauthenticated fire-and-forget from frontend. It uses secret key server-side, but anyone can trigger it to spam the FX provider. Consider admin auth or Netlify signed request + rate limit.
- **P2**: CSP has `style-src 'self' 'unsafe-inline'` (needed for Tailwind). Could tighten with nonce if desired. `X-Frame-Options` intentionally omitted for preview iframes; consider `frame-ancestors 'self'` for prod.
- **P2**: Demo mode passwords stored plaintext in `wt_users` localStorage. Acceptable for demo, but warn users not to reuse real passwords (or hash).
- **P3**: `theme-init.js` always adds `christmas` class before paint, even when `VITE_CHRISTMAS_THEME=off`, causing flash. Should respect env flag.
- **P3**: No virtualization for EntriesPage (200 visible rows). Could use react-window for 5000 max working set.
- **P3**: Permission list duplicated in 3 places (types.ts, schema.sql, create-worker.ts). Current comment warns, but consider generated file or CI check.
- **P3**: `computeTotalMinutes` handles crossing midnight by +24h, but multi-day or clock-skew edge could be explicit.

## Security Highlights (kept)

- Triple-layer enforcement (UI hide, backend `can()`, RLS `has_permission()`) — exemplary.
- Secrets correctly split: VITE_ anon only, SUPABASE_SECRET_KEY server-only.
- No `dangerouslySetInnerHTML`, `eval`, `innerHTML`.
- Slack webhook URL validated with `^https://hooks.slack.com/` in frontend and backend, message rebuilt from DB not client text.
- PWA runtimeCaching excludes Supabase (prevents cross-account leak).
- Storage wrapper handles sandboxed iframe localStorage blocking.
- FX sync validates finite >0, fails closed.

## Files Changed

- `netlify/functions/create-worker.ts` — add invoices.view
- `netlify/functions/delete-worker.ts` — scoped reset, 15 tables, notepad cleanup
- `src/lib/image.ts` — size limit, allowlist, validateImageFile
- `src/pages/SettingsPage.tsx` — use validateImageFile everywhere
- `src/lib/personalFinance.ts` — use storage wrapper
- `src/lib/localDb.ts` — clear slackKey on reset
- `package.json` / `package-lock.json` — vite 6.4.3, react-router-dom 7.18.3, uuid override

## How to Apply to Main

This branch `arena/01a0a10c-time-tracker` contains all fixes. Merge or cherry-pick, then run:

```
npm install
npm run typecheck && npm run lint && npm run build
npm audit
npm run verify
```

Supabase: no migration needed (code is defensive for missing tables). If finance tables not yet installed, `supabase/finance.sql` still recommended for full permission set.
