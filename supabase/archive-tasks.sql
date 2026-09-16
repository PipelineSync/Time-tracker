-- ============================================================
-- Work Tracker — Archive completed tasks
-- ------------------------------------------------------------
-- Run this once in the Supabase SQL editor on an existing database.
-- Fresh installs get the column from schema.sql.
--
-- Adds archived_at to tasks to allow archiving completed cards
-- from the kanban board while keeping historical records.
-- ============================================================

alter table public.tasks
  add column if not exists archived_at timestamptz;

create index if not exists tasks_worker_status_archived_idx
  on public.tasks (worker_id, status, archived_at);
