-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--   1. Adds a 'recurring' stage to public.tasks — the leftmost board
--      column ("Recurring"), the shelf where repeating tasks live as their
--      template. "Start an occurrence" flips a shelf card into 'todo' with
--      its due date advanced one repeat interval.
--
--  Everything else (workflows, RLS) is unchanged: a shelf card is just a
--  task in a new stage, so workers can only start/return their own.
--
--  Safe to re-run: the constraint is dropped and re-added idempotently.
--  Requires: RUN-THIS-tasks.sql already applied (for public.tasks).
-- ============================================================================

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('recurring','todo','in_progress','waiting','for_review','rework','completed'));

-- Verify: any rows already sitting on the shelf (none expected on a fresh
-- database — the stage is opt-in from the app)
select id, title, status, repeats, due_date
from public.tasks
where status = 'recurring'
order by created_at desc
limit 10;
