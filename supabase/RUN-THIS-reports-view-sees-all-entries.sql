-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it fixes
--  -------------
--  A worker the admin granted **Reports** (`reports.view`) used to get a
--  report of *themselves only*: the reports are built out of `time_entries`,
--  and the row level security policy only ever let a worker read their own
--  rows unless they also held `entries.view_all`. The Reports page therefore
--  showed one worker's hours and earnings — a self-report — no matter which
--  buttons the admin had ticked.
--
--  What it does
--  ------------
--   1. widens `time_entries_select`: a worker who holds `reports.view` reads
--      the whole workspace's entries, exactly like one holding
--      `entries.view_all` (read-only — writing still needs `entries.manage`)
--   2. adds `entries.view_all` to every worker row that already has
--      `reports.view`, so the stored grants match what the app now implies
--      (the app ticks both the moment Reports is granted)
--
--  Safe to re-run: the policy is dropped and re-created, and the backfill
--  only touches rows that are missing the key.
--
--  Prerequisite: the worker access migration (supabase/worker-permissions.sql,
--  or supabase/RUN-THIS-clients-and-permissions.sql part 2) must already have
--  been run — this file uses public.has_permission(text). If your workers can
--  already be granted access, you are good.
--
--  A brand-new database created from supabase/schema.sql already has the
--  policy below and does not need this file.
-- ============================================================================

-- ---------- 1. the team-wide entry read also follows Reports ----------
drop policy if exists "time_entries_select" on public.time_entries;
create policy "time_entries_select" on public.time_entries
  for select using (
    (select auth.uid()) = user_id
    or worker_id = (select public.current_worker_id())
    -- The team-wide time read: granted outright (`entries.view_all`) or
    -- through Reports (`reports.view`) — a report is built out of everyone's
    -- entries, so reporting on the team needs the team's rows.
    or (user_id = (select public.workspace_owner_id())
        and ((select public.has_permission('entries.view_all'))
             or (select public.has_permission('reports.view'))))
  );

-- ---------- 2. backfill: Reports now implies the team-wide read ----------
update public.workers
   set permissions = array_append(permissions, 'entries.view_all')
 where 'reports.view' = any(permissions)
   and not ('entries.view_all' = any(permissions));

-- ---------- verify ----------
-- Expect: the four time_entries policies, and no worker holding reports.view
-- without entries.view_all.
select policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'time_entries'
order by policyname;

select id, name, permissions
from public.workers
where 'reports.view' = any(permissions);
