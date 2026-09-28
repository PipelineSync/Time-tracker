-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--    * adds the `start_date` column to `tasks` — the date a task starts /
--      started. Every task now carries one: the app requires it on new
--      tasks (the form pre-fills today) and shows it on every card.
--    * back-fills every existing task that has no start date from its
--      creation date (UTC day — the same value the app reads), so nothing
--      is blank.
--    * also back-fills the `started_at` stage stamp on cards that are past
--      To Do but predate it (the same back-fill RUN-THIS-team-kpi.sql does,
--      widened to the rework column) so the KPI timeline stays complete.
--
--  Safe to re-run: every statement is idempotent, so running it twice
--  changes nothing and loses no data. Fresh installs get the column from
--  schema.sql. Until this runs the app still works — reads back-fill the
--  date on the fly, and writes save everything else.
-- ============================================================================


-- ---------- 1. column ----------
alter table public.tasks add column if not exists start_date date;


-- ---------- 2. back-fill ----------
-- Tasks written before the column existed start on the day they were
-- created. (created_at at time zone 'utc')::date matches exactly what the
-- app computes when it back-fills on read, so the value never jumps.
update public.tasks set start_date = (created_at at time zone 'utc')::date
where start_date is null;

-- Working cards that predate the stage stamps get their Started At from the
-- day they were created too (waiting/for_review/todo cards have not started
-- yet — they carry their start_date until the card enters In Progress).
update public.tasks set started_at = created_at
where started_at is null
  and status in ('in_progress', 'completed', 'rework');


-- ---------- 3. verify ----------
-- Should list every task with a non-null start_date (0 rows = all good).
select id, title, start_date from public.tasks where start_date is null;
