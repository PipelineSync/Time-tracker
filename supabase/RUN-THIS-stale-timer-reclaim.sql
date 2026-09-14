-- ============================================================
-- Fix: workers locked out of their own clock — "Not your timer."
-- ============================================================
-- Run this ONCE in the Supabase SQL editor on an existing database.
-- Fresh installs get the same function from supabase/schema.sql.
-- Everything here is idempotent and safe to re-run.
--
-- Background
-- ----------
-- A worker login is tied to a `workers` row through their profile. When the
-- admin re-creates that worker record mid-shift (delete + re-add, or the
-- email-based profile repair re-points the link), the worker's RUNNING TIMER
-- stays on the OLD row. From then on every ownership check —
-- "timer.worker_id === my worker link" — fails against the NEW link, so the
-- worker cannot take a break, switch client, or clock out; they only get
-- "Not your timer.", and the timer keeps ticking on a row nobody can operate.
-- RLS makes it worse: the worker can no longer even SEE the stale row
-- (select/update/delete scope on current_worker_id()), so nothing client-side
-- can move it. Team-wide accounts (a project manager granted
-- `entries.view_all`) are hit hardest: their reads run through the team-wide
-- policy and skip the scoped self-heal entirely.
--
-- This file:
--   1) creates `reclaim_my_timers()` — the SECURITY DEFINER function the app
--      calls at the start of every timer action (clock in, break, resume,
--      switch client, clock out, cancel). It moves a stale running timer back
--      onto the caller's CURRENT worker row, only when it is provably theirs.
--      It can never touch a coworker's timer.
--   2) repairs existing stuck rows once, so workers who are on the clock
--      right now with a stale link are free again immediately.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- 1) The reclaim function the app calls. Guards, all inside the function:
--    * caller is a signed-in WORKER with a current worker link in their profile;
--    * the timer sits on a worker row in the CALLER'S workspace whose login
--      email equals the caller's auth email (email is the app's own re-link
--      anchor — sync-worker-profile re-links exactly this way);
--    * that old worker row is claimed by NO profile — otherwise it really is
--      somebody else's clock;
--    * one running timer per worker still holds: the newest stale timer is
--      re-adopted; older leftovers of the same person are dropped, the same
--      rule the app's scoped timer list has always applied.
-- ------------------------------------------------------------
create or replace function public.reclaim_my_timers()
returns setof public.active_timers
language plpgsql
security definer
set search_path = public
as $$
declare
  me_id     uuid := auth.uid();
  my_email  text;
  my_worker uuid;
  owner_id  uuid;
  victim_id uuid;
begin
  if me_id is null then
    return;
  end if;

  select lower(au.email) into my_email from auth.users au where au.id = me_id;
  select p.worker_id into my_worker from public.profiles p
   where p.user_id = me_id and p.role = 'worker';
  -- An account without a (worker) profile link, or an admin, has nothing to
  -- reclaim: admins operate every timer through their own normal policies.
  if my_worker is null or my_email is null then
    return;
  end if;

  owner_id := public.workspace_owner_id();
  if owner_id is null then
    return;
  end if;

  -- The newest stale timer of mine, if any, on an unclaimed worker row in my
  -- workspace carrying my login email.
  select t.id into victim_id
  from public.active_timers t
  join public.workers w on w.id = t.worker_id
  where t.worker_id <> my_worker
    and w.user_id = owner_id
    and lower(coalesce(w.email, '')) = my_email
    and not exists (select 1 from public.profiles p where p.worker_id = t.worker_id)
  order by t.start_time desc
  limit 1;

  if victim_id is null then
    return;
  end if;

  if exists (select 1 from public.active_timers x where x.worker_id = my_worker) then
    -- My current row already runs a timer, so this stale row is a leftover
    -- duplicate nobody can operate anymore (the one-per-worker unique index
    -- would also refuse to move it). Drop it, like the app's scoped list does.
    delete from public.active_timers where id = victim_id;
    return;
  end if;

  update public.active_timers set worker_id = my_worker where id = victim_id;
  return query select * from public.active_timers where id = victim_id;
end;
$$;

-- ------------------------------------------------------------
-- 2) One-time repair of currently stuck rows (same rules, applied to every
--    worker at once; this runs as the SQL-editor role, which is why the app
--    needed a definer function for its side of the job). Idempotent — re-run
--    is a no-op. Leave this in place: the app's own reclaim covers everything
--    after the deploy anyway.
-- ------------------------------------------------------------
with ranked as (
  select
    t.id as timer_id,
    p.worker_id as new_worker_id,
    row_number() over (partition by p.worker_id order by t.start_time desc) as newest_first,
    exists (
      select 1 from public.active_timers c where c.worker_id = p.worker_id
    ) as target_busy
  from public.profiles p
  join auth.users au on au.id = p.user_id
  join public.workers nw on nw.id = p.worker_id
  join public.active_timers t on t.worker_id <> p.worker_id and t.user_id = nw.user_id
  join public.workers ow on ow.id = t.worker_id
  where p.role = 'worker'
    and lower(coalesce(au.email, '')) = lower(coalesce(ow.email, ''))
    and not exists (select 1 from public.profiles p2 where p2.worker_id = t.worker_id)
)
update public.active_timers t
set worker_id = r.new_worker_id
from ranked r
where r.timer_id = t.id
  and r.newest_first = 1
  and not r.target_busy;

-- ------------------------------------------------------------
-- Verify (optional): no runnable timer should sit on a worker row that no
-- profile claims while its email matches a signed-in worker's login.
--
-- select t.id, t.worker_id as timer_row, p.worker_id as my_current_row
-- from public.active_timers t
-- join public.workers ow on ow.id = t.worker_id
-- join public.profiles p on p.role = 'worker'
-- join auth.users au on au.id = p.user_id
-- where t.worker_id <> p.worker_id
--   and lower(coalesce(au.email, '')) = lower(coalesce(ow.email, ''))
--   and not exists (select 1 from public.profiles p2 where p2.worker_id = t.worker_id);
-- ------------------------------------------------------------
