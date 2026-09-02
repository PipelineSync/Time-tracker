-- ---------------------------------------------------------------------------
-- Multiple workers on the clock at once + break visibility for the admin
-- ---------------------------------------------------------------------------
-- Run this once in the Supabase SQL editor on databases created before this
-- change. Everything here is idempotent and safe to re-run.
--
-- 1) Make sure timers are limited to one *per worker*, not one per workspace.
--    Older databases had a unique index on user_id; because every timer row is
--    owned by the workspace admin (user_id), that index let only ONE worker be
--    clocked in at a time and made the admin dashboard show a single worker.
-- 2) Allow the break notification types so the admin is told when a worker
--    starts or ends a break.
-- ---------------------------------------------------------------------------

-- 1) One timer per worker (many workers may run at the same time)
drop index if exists public.active_timers_one_per_user;
drop index if exists active_timers_one_per_user;

-- Remove duplicate rows for the same worker (keep the most recent) so the
-- unique index below can be created.
delete from public.active_timers a
using public.active_timers b
where a.worker_id = b.worker_id
  and a.start_time < b.start_time;

create unique index if not exists active_timers_one_per_worker
  on public.active_timers (worker_id);
create index if not exists active_timers_worker_id_idx
  on public.active_timers (worker_id);

-- 2) Break notifications ('break_start' / 'break_end')
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('note','time_in','time_out','time_added','payment','break_start','break_end'));

-- 3) The admin must be able to read every timer in their workspace.
--    (Same policy as schema.sql — re-created here for older databases.)
drop policy if exists "active_timers_select" on public.active_timers;
create policy "active_timers_select" on public.active_timers
  for select using (auth.uid() = user_id or worker_id = public.current_worker_id());
