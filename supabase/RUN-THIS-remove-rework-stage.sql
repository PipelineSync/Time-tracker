-- ============================================================
-- Remove the Rework task stage
--
-- Run this once in the Supabase SQL Editor for an existing workspace.
-- Legacy Rework tasks move to In Progress; stage_history is left intact as
-- an audit trail. The app also normalizes legacy statuses on read.
-- Safe to re-run.
-- ============================================================

begin;

alter table public.tasks drop constraint if exists tasks_status_check;

update public.tasks
   set status = 'for_review'
 where status = 'approval';

update public.tasks
   set status = 'in_progress'
 where status = 'rework';

alter table public.tasks add constraint tasks_status_check
  check (status in ('recurring', 'todo', 'in_progress', 'waiting', 'for_review', 'completed'));

commit;
