-- ============================================================
-- Switch client: keep the shift clock continuous
-- ============================================================
-- When a worker switches clients mid-shift, the previous segment is still
-- saved as a finished time entry for the old client (correct allocation),
-- but the on-screen timer should keep counting from the original clock-in
-- instead of resetting to 00:00:00.
--
-- These two columns on active_timers make that possible:
--   session_start   — original clock-in for the whole shift
--   prior_worked_ms — working milliseconds already split into finished
--                     entries earlier in this shift (previous clients)
--
-- The live display is: prior_worked_ms + (now − start_time − pauses).
-- Client billing still uses start_time of the current segment only.
--
-- Safe to re-run. The app also degrades without these columns (the clock
-- still allocates correctly; it just resets on switch until this is applied).
-- ============================================================

alter table public.active_timers
  add column if not exists session_start timestamptz;

alter table public.active_timers
  add column if not exists prior_worked_ms bigint not null default 0;

-- Existing running timers: treat their current start as the session start
-- and leave prior_worked_ms at 0 (nothing was split yet from their POV).
update public.active_timers
   set session_start = start_time
 where session_start is null;
