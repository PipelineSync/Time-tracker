-- ============================================================
-- Clock sounds: readiness check (nothing to install)
-- ============================================================
-- The clock cues (src/lib/sounds.ts) and the admin's opt-in "hear the team"
-- chime (src/lib/teamSounds.ts) need NO schema change: no table, no column, no
-- policy. The tones are synthesised in the browser and the preference lives in
-- that device's storage, so there is nothing to run here for the feature to
-- work.
--
-- This script exists only to prove it on a real database. It is read-only and
-- safe to re-run.
--
-- What the cues read:
--   1. active_timers.paused
--        a break is invisible anywhere else, so the "break started / back to
--        work" cues are this flag flipping.
--   2. the "active_timers_select" row-level-security policy
--        the team chime diffs successive copies of the admin's timer list. If
--        that read ever stops returning the whole team, the chime goes quiet —
--        and so does the Dashboard's "On the clock now" panel, which is the
--        more visible symptom.
--   3. the one-timer-per-worker unique index
--        a client switch closes the timer row and opens a fresh one under a new
--        id. The diff reads "one out + one in for the same worker" as *still
--        working, stay silent* — correct only while a worker can hold a single
--        row. Two rows at once would turn every switch into a noise.
--
-- The last query lists who is on the clock right now — the exact snapshot the
-- chime compares between refreshes. Note the SQL editor connects as a
-- privileged role that bypasses RLS, so that listing shows every row no matter
-- who you are; it is there to eyeball the data, not to test the policy.
-- ============================================================

-- 1–3. the three dependencies, one PASS/FAIL grid --------------------------
select
  'active_timers.id exists' as "check",
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'active_timers' and column_name = 'id'
  ) then 'PASS' else 'FAIL — run supabase/schema.sql' end as result
union all
select
  'active_timers.paused exists (break cues depend on it)',
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'active_timers' and column_name = 'paused'
  ) then 'PASS' else 'FAIL — run supabase/schema.sql' end
union all
select
  'active_timers has row level security enabled',
  case when exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'active_timers' and c.relrowsecurity
  ) then 'PASS' else 'FAIL — timers are readable without RLS' end
union all
select
  'RLS policy "active_timers_select" (SELECT) is in place',
  case when exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'active_timers'
      and policyname = 'active_timers_select' and cmd = 'SELECT'
  ) then 'PASS' else 'FAIL — the team list read will come back empty' end
union all
select
  'worker can only ever hold one running timer',
  case when exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'active_timers'
      and indexname = 'active_timers_one_per_worker'
  ) then 'PASS' else 'FAIL — run supabase/schema.sql (client switches would chime)' end
union all
select
  'shift continuity columns (session_start / prior_worked_ms)',
  case when exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'active_timers' and column_name = 'session_start'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'active_timers' and column_name = 'prior_worked_ms'
  ) then 'PASS' else 'optional — run supabase/switch-client-session.sql' end
order by 1;

-- What the chime is looking at right now ---------------------------------
select
  w.name                                          as worker,
  t.paused                                        as on_break,      -- break cue = this flipping
  t.start_time                                    as segment_start, -- a new id here is a clock-in…
  coalesce(t.session_start, t.start_time)         as clocked_in_at, -- …but the shift keeps its origin
  c.name                                          as client,
  greatest(0, floor(extract(epoch from (now() - t.start_time))))::bigint as segment_seconds
from public.active_timers t
left join public.workers w on w.id = t.worker_id
left join public.clients c on c.id = t.client_id
order by t.paused desc, t.start_time;
