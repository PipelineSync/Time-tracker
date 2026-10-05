-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--  "QA Required?" becomes a REQUEST, not a lock:
--
--    * Anyone who may edit a card can tick or untick it (their own board, or
--      the whole team's with `tasks.manage_all`) — not only the Owner and
--      people with `team_kpi.view`.
--    * A ticked card can still be moved to Completed by whoever finishes the
--      work. The QA score (1–5 + rework classification) stays with the Owner
--      and `team_kpi.view` holders — only the guard that refused the tick and
--      the completion is removed.
--
--  Concretely, this file
--    1. drops the `trg_tasks_qa_required` guard trigger from `tasks`, and
--    2. replaces `enforce_task_qa_required()` with a permissive version, so an
--       older migration that recreates the trigger (re-running
--       supabase/RUN-THIS-task-qa-required.sql or
--       supabase/RUN-THIS-recurring-no-qa.sql, both of which install it) does
--       not bring the lock back — just run this file again afterwards.
--
--  The `qa_required` column itself is untouched: it keeps its default (Yes for
--  a new one-off task, No for a repeating one) and every card keeps the value
--  it has. It simply no longer refuses anything.
--
--  Requires: supabase/RUN-THIS-task-qa-required.sql (the column). Fresh
--  installs read the column from schema.sql and never install a trigger, so
--  they never need this file.
--
--  Safe to re-run: every statement is idempotent.
-- ============================================================================


-- ---------- 0. prerequisite check ----------
do $$
begin
  if to_regclass('public.tasks') is null then
    raise exception 'Run supabase/tasks.sql (or schema.sql) first — there is no public.tasks table.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'qa_required'
  ) then
    raise exception 'Run supabase/RUN-THIS-task-qa-required.sql first — this file only opens up an existing QA Required? column.';
  end if;
end
$$;


-- ---------- 1. drop the guard trigger ----------
-- The app, the connector and the database all treat the tick as editable by
-- anyone who can edit the card, so there is nothing left to guard.
drop trigger if exists trg_tasks_qa_required on public.tasks;


-- ---------- 2. retire the guard function ----------
-- Kept (permissive) rather than dropped: a database that re-runs an older QA
-- migration would re-create the trigger against this name, and that trigger
-- must never block a write again.
create or replace function public.enforce_task_qa_required()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- "QA Required?" is a request for review, not a lock: iOS/Android/web, the
  -- Claude connector and this trigger all let the card be edited and completed
  -- by whoever may edit it. QA is scored in For Review (the app's Review
  -- dialog), which is enforced by the app, not by this trigger.
  return new;
end
$$;


-- ---------- 3. verify ----------
-- One row. Right after the run: guard_installed = false, and the two counts
-- are the cards asking for QA / not asking. Nothing else changes.
select
  (select count(*) from public.tasks where qa_required)     as tasks_asking_for_qa,
  (select count(*) from public.tasks where not qa_required) as tasks_without_qa,
  exists (
    select 1 from pg_trigger
     where tgname = 'trg_tasks_qa_required'
       and not tgisinternal
  ) as guard_installed;
