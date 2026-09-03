-- ============================================================
-- OPTIONAL: performance insurance for the incremental entry sync
--
-- The app's 15-second background tick asks: "which entries were
-- created or updated since my last sync?" — i.e.
--
--     where created_at >= :t or updated_at >= :t
--
-- On a small workspace (a few thousand rows) that is a
-- sub-millisecond scan and the app runs perfectly WITHOUT this
-- file. You only need it if public.time_entries grows into the
-- tens of thousands of rows and you want that query to keep
-- using indexes.
--
-- Safe to run more than once. Adds two small indexes and nothing
-- else; changes no permissions, no data, no behaviour.
--
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================

create index if not exists time_entries_created_at_idx
  on public.time_entries (created_at);

create index if not exists time_entries_updated_at_idx
  on public.time_entries (updated_at);

-- Let the planner know the new indexes exist right away.
analyze public.time_entries;
