-- ============================================================
-- Work Tracker — Settling keeps time entries
-- ------------------------------------------------------------
-- Run this once in the Supabase SQL editor on an existing database.
-- Fresh installs already get the column from schema.sql.
--
-- "Settle & reset" used to delete a worker's time entries as soon
-- as it created their payment. It now keeps them: the entries it
-- pays for are stamped with settled_at instead, so they stay in
-- Time Entries (notes included) until someone deletes one by hand,
-- and the next settlement only covers the time worked since.
--
-- Without this column the app still refuses to delete entries — it
-- falls back to the newest payment's period_end as the "already
-- paid up to" boundary — but applying the migration is what keeps
-- settled time from being counted twice with full accuracy.
-- ============================================================

alter table public.time_entries
  add column if not exists settled_at timestamptz;

-- Settlements look a worker up by (worker_id, settled_at is null).
create index if not exists time_entries_worker_settled_idx
  on public.time_entries (worker_id, settled_at);

-- Nothing to backfill: the old settle action deleted the entries it paid for,
-- so every row still in the table is unsettled (settled_at = null).
