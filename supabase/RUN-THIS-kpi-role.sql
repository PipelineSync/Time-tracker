-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--    * adds the `kpi_role` column to `workers` — the "KPI role" picker on
--      Workers → edit. It chooses the Monthly Goal formula that Team KPI uses
--      for that person. (The KPI score itself is 40% On-Time + 40% QA +
--      20% Monthly Goal; rework is still shown but no longer scored.)
--
--        project               80% planned new-client / project work
--                            + 20% recurring / internal work
--        maintenance_outreach  70% maintenance tasks
--                            + 30% outreach / other assigned work
--        social_media          60% recurring social media tasks
--                            + 40% planned content deliverables
--        (empty)               no role: tasks completed ÷ the Tasks plan the
--                              Owner types in each month (the old goal)
--
--      Each side is scored as "completed ÷ due that month". Repeating tasks
--      and tasks for the client named "Internal" are the recurring side; every
--      other task is planned work.
--    * adds workers_kpi_role_check so only those three values (or empty) can
--      be stored.
--
--  Nobody is given a role automatically. After this runs, open Workers →
--  edit a worker and pick the KPI role for each person; until a worker has
--  one, they keep the Tasks-plan Monthly Goal.
--
--  Safe to re-run: every statement is idempotent, so running it twice changes
--  nothing and loses no data. Fresh installs get all of it from schema.sql.
--  Until this runs the app still works — the KPI role picker saves everything
--  else and says which file to run, and every worker reads as "no role".
-- ============================================================================

alter table public.workers add column if not exists kpi_role text;

alter table public.workers drop constraint if exists workers_kpi_role_check;
alter table public.workers add constraint workers_kpi_role_check check (
  kpi_role is null
  or kpi_role in ('project', 'maintenance_outreach', 'social_media')
);

-- Verify: your workers and their KPI role (empty until you pick one in the app).
select id, name, position, kpi_role from public.workers order by name;
