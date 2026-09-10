-- ============================================================
-- Work Tracker — Subscription occurrence limits (Finance)
--
-- Run this in the Supabase SQL editor on an existing database to let a
-- subscription run "for a set number of bills" and pause itself when the
-- last one is billed. New databases get the same columns from
-- supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. adds finance_items.max_occurrences — how many times a subscription
--      bills before it pauses by itself (null = runs until someone switches
--      it off, which is what every existing subscription keeps doing)
--   2. adds finance_items.billed_count — how many of those bills have
--      happened; the app counts one each time the next due date is rolled
--      forward ("Billed"), and reaching the limit pauses the subscription
--
-- No RLS changes: the finance_items policies from supabase/finance.sql
-- already cover these columns (they sit on the same rows).
-- ============================================================

alter table public.finance_items
  add column if not exists max_occurrences integer check (max_occurrences is null or max_occurrences > 0);

alter table public.finance_items
  add column if not exists billed_count integer not null default 0;

-- ---------- verify ----------
-- Expect: one row per subscription, with its limit (null = until switched off).
select name, cycle, max_occurrences, billed_count
  from public.finance_items
 where kind = 'subscription'
 order by name;
