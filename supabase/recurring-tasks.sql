-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--   1. Adds `repeats` to public.tasks: 'none' (default) or one of the
--      repeat intervals (daily / weekly / biweekly / monthly).
--   2. Adds `repeat_until` (date): the optional end of a series — once the
--      computed next due date passes it, "Recreate next" is not offered.
--   3. Adds `series_id` (uuid): the id the series started from. Every
--      "Recreate next" clone inherits it, so a chain is traceable.
--   4. Adds `occurrence` (integer): 1 = the original, 2+ = a clone created
--      by "Recreate next".
--
--  Recurring tasks are fully optional: nothing repeats by itself. A
--  repeating COMPLETED card gets a "Recreate next" action that clones it
--  into a new To Do card with the due date advanced by one interval.
--
--  Safe to re-run: every statement is idempotent.
-- ============================================================================

alter table public.tasks add column if not exists repeats text not null default 'none';

alter table public.tasks drop constraint if exists tasks_repeats_check;
alter table public.tasks add constraint tasks_repeats_check
  check (repeats in ('none', 'daily', 'weekly', 'biweekly', 'monthly'));

alter table public.tasks add column if not exists repeat_until date;

alter table public.tasks add column if not exists series_id uuid;

alter table public.tasks drop constraint if exists tasks_occurrence_check;
alter table public.tasks add constraint tasks_occurrence_check
  check (occurrence is null or occurrence >= 1);
alter table public.tasks add column if not exists occurrence integer;

-- Verify: show the new columns on a few tasks
select id, title, status, repeats, repeat_until, series_id, occurrence
from public.tasks
order by created_at desc
limit 10;
