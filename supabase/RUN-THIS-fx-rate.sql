-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  It is the ONLY database change needed for the USD → PHP reference rate.
--  Safe to re-run: every statement is idempotent (add column if not exists),
--  so running it twice changes nothing and loses no data.
--
--  What it does
--  ------------
--    * adds two columns to the EXISTING `settings` row:
--        - usd_php_rate            the latest USD → PHP rate (null = unknown)
--        - usd_php_rate_updated_at when the cron last refreshed it
--
--  Why on `settings` and not a new table
--  -------------------------------------
--    Every signed-in tab already fetches `settings` about once a minute (it is
--    skipped on the "light" 15-second ticks — see the tick budget comment in
--    src/lib/store.tsx). Riding along on a request the app already makes means
--    the rate costs ZERO extra database queries, ZERO extra rows, and about
--    75 extra bytes per settings read. A separate `exchange_rates` table would
--    have added one query per client per refresh for a number that only moves
--    once per business day.
--
--  Who writes it
--  -------------
--    The `sync-fx-rate` Netlify Function, on a daily schedule (see
--    netlify.toml). It runs server-side with SUPABASE_SECRET_KEY, so it can
--    update the row without a user token — the same credential pattern the
--    other functions in netlify/functions/lib/supabase.ts already use.
--    Clients only ever READ it, through the settings policies that already
--    exist. No RLS change is needed: the existing policies cover new columns.
--
--  Both columns are nullable on purpose. A fresh database has no rate until
--  the cron first runs, and the app falls back to a bundled reference rate
--  (FALLBACK_USD_PHP_RATE in src/lib/fx.ts) rather than showing nothing.
--
--  Requires: schema.sql already applied (for the `settings` table).
-- ============================================================================


-- ---------- 1. columns ----------
alter table public.settings
  add column if not exists usd_php_rate numeric(12,4);

alter table public.settings
  add column if not exists usd_php_rate_updated_at timestamptz;

-- A rate of 0 would silently zero out every converted figure; a negative one
-- is nonsense. Both are rejected at the door. Existing rows keep null, which
-- is the documented "unknown, use the fallback" state.
alter table public.settings
  drop constraint if exists settings_usd_php_rate_sane;

alter table public.settings
  add constraint settings_usd_php_rate_sane
  check (usd_php_rate is null or usd_php_rate > 0);

comment on column public.settings.usd_php_rate is
  'Latest USD to PHP reference rate, refreshed daily by the sync-fx-rate Netlify Function. Null = not fetched yet.';

comment on column public.settings.usd_php_rate_updated_at is
  'When usd_php_rate was last written by the sync-fx-rate function.';
