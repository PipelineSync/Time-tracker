-- ===========================================================================
-- Work Tracker — Chrome extension support
-- ===========================================================================
-- The Chrome extension in `extension/` (clock in / break / clock out) does NOT
-- need any new tables or columns. `supabase/schema.sql` already creates every
-- object it uses, and the extension is deliberately built so that nothing here
-- has to run on an up-to-date database.
--
-- Copy this file into the Supabase SQL editor only if:
--   * your database was created before one of these objects existed, or
--   * the verification query below reports FAIL on any row, or
--   * a worker sees "Your workspace rejected that" in the extension.
--
-- Everything below is idempotent and safe to re-run. It recreates objects
-- exactly as `supabase/schema.sql` defines them, so running it on a healthy
-- database changes nothing.
--
-- ===========================================================================
-- STEP 1 — Check (read-only). Run this first. Every row should say PASS.
-- ===========================================================================

select 'workspace_owner_id() function'                    as requirement,
       case when to_regprocedure('public.workspace_owner_id()') is not null then 'PASS' else 'FAIL' end as status
union all
select 'current_worker_id() function',
       case when to_regprocedure('public.current_worker_id()') is not null then 'PASS' else 'FAIL' end
union all
select 'one timer per worker (unique index)',
       case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'active_timers_one_per_worker') then 'PASS' else 'FAIL' end
union all
select 'old one-timer-per-workspace index removed',
       case when not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'active_timers_one_per_user') then 'PASS' else 'FAIL' end
union all
select 'worker can clock in (policy active_timers_insert_worker)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'active_timers' and policyname = 'active_timers_insert_worker') then 'PASS' else 'FAIL' end
union all
select 'worker can read own timer (policy active_timers_select)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'active_timers' and policyname = 'active_timers_select') then 'PASS' else 'FAIL' end
union all
select 'worker can start/end a break (policy active_timers_update)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'active_timers' and policyname = 'active_timers_update') then 'PASS' else 'FAIL' end
union all
select 'worker can delete own timer on clock out (policy active_timers_delete)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'active_timers' and policyname = 'active_timers_delete') then 'PASS' else 'FAIL' end
union all
select 'worker can insert own time entry (policy time_entries_insert)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'time_entries' and policyname = 'time_entries_insert') then 'PASS' else 'FAIL' end
union all
select 'worker can notify the admin (policy notifications_insert)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_insert') then 'PASS' else 'FAIL' end
union all
select 'worker can read own profile (policy profiles_select)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select') then 'PASS' else 'FAIL' end
union all
select 'worker can read own worker row (policy workers_select)',
       case when exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workers' and policyname = 'workers_select') then 'PASS' else 'FAIL' end
union all
select 'break notification types allowed',
       case when exists (
              select 1
              from pg_constraint c
              join pg_class t on t.oid = c.conrelid
              join pg_namespace n on n.oid = t.relnamespace
              where n.nspname = 'public'
                and t.relname = 'notifications'
                and c.conname = 'notifications_type_check'
                and pg_get_constraintdef(c.oid) like '%break_start%'
                and pg_get_constraintdef(c.oid) like '%break_end%'
            ) then 'PASS' else 'FAIL' end
union all
select 'active_timers stamps the workspace owner (trigger)',
       case when exists (select 1 from pg_trigger where tgname = 'trg_active_timers_user' and not tgisinternal) then 'PASS' else 'FAIL' end
union all
select 'time_entries stamps the workspace owner (trigger)',
       case when exists (select 1 from pg_trigger where tgname = 'trg_time_entries_user' and not tgisinternal) then 'PASS' else 'FAIL' end
order by 1;

-- ===========================================================================
-- STEP 2 — Repair. Only needed if any row above said FAIL.
--          Safe to re-run; recreates objects exactly as schema.sql defines them.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Helper functions the policies rely on
-- ---------------------------------------------------------------------------
create or replace function public.current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select worker_id from public.profiles where user_id = auth.uid();
$$;

-- Resolves the admin who owns the signed-in user's workspace. Rows are owned
-- by that admin (not by the worker), which is what lets the admin dashboard,
-- Time Entries and Reports show a worker's punches.
create or replace function public.workspace_owner_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.user_id from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'),
    (
      select w.user_id
      from public.profiles p
      join public.workers w on w.id = p.worker_id
      where p.user_id = auth.uid() and p.role = 'worker'
    )
  );
$$;

grant execute on function public.current_worker_id() to authenticated;
grant execute on function public.workspace_owner_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 2) One timer per worker (so several workers can be clocked in at once)
-- ---------------------------------------------------------------------------
-- Older databases limited the whole workspace to a single running timer, which
-- made the admin dashboard show only one worker and blocked clock-ins with
-- "duplicate key value violates unique constraint".
drop index if exists public.active_timers_one_per_user;

-- Remove duplicate rows (keeping the most recent) so the unique index can be
-- created. No-op when the index already exists — there can be no duplicates.
-- `ctid` only breaks ties between rows with an identical start_time.
delete from public.active_timers a
using public.active_timers b
where a.worker_id = b.worker_id
  and (a.start_time < b.start_time or (a.start_time = b.start_time and a.ctid < b.ctid));

create unique index if not exists active_timers_one_per_worker on public.active_timers (worker_id);
create index if not exists active_timers_worker_id_idx on public.active_timers (worker_id);

-- ---------------------------------------------------------------------------
-- 3) Break notification types
-- ---------------------------------------------------------------------------
-- Databases created before breaks existed reject 'break_start' / 'break_end'.
-- All eight types the app can emit are listed, so nothing existing is lost.
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('note','time_in','time_out','time_added','payment','break_start','break_end','chat'));

-- ---------------------------------------------------------------------------
-- 4) Row Level Security policies the worker's session needs
-- ---------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.workers        enable row level security;
alter table public.active_timers  enable row level security;
alter table public.time_entries   enable row level security;
alter table public.notifications  enable row level security;

-- A worker reads their own profile and their own worker row (name + rate).
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "workers_select" on public.workers;
create policy "workers_select" on public.workers
  for select using ((select auth.uid()) = user_id or id = (select public.current_worker_id()));

-- Clock in / break / clock out: a worker may only touch their own timer.
drop policy if exists "active_timers_select" on public.active_timers;
create policy "active_timers_select" on public.active_timers
  for select using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "active_timers_insert" on public.active_timers;
create policy "active_timers_insert" on public.active_timers
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "active_timers_insert_worker" on public.active_timers;
create policy "active_timers_insert_worker" on public.active_timers
  for insert with check (
    worker_id = (select public.current_worker_id())
    and worker_id is not null
    and user_id = (select public.workspace_owner_id())
  );

drop policy if exists "active_timers_update" on public.active_timers;
create policy "active_timers_update" on public.active_timers
  for update using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "active_timers_delete" on public.active_timers;
create policy "active_timers_delete" on public.active_timers
  for delete using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

-- Clock out writes the finished entry.
drop policy if exists "time_entries_select" on public.time_entries;
create policy "time_entries_select" on public.time_entries
  for select using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "time_entries_insert" on public.time_entries;
create policy "time_entries_insert" on public.time_entries
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (worker_id = (select public.current_worker_id()) and user_id = (select public.workspace_owner_id()))
  );

-- Clock in / break / clock out notify the admin.
drop policy if exists "notifications_insert" on public.notifications;
create policy "notifications_insert" on public.notifications
  for insert with check (
    (select public.is_admin())
    or (select auth.uid()) = user_id
    or user_id = (select public.workspace_owner_id())
  );

-- ---------------------------------------------------------------------------
-- 5) Triggers that stamp every row with the workspace owner
-- ---------------------------------------------------------------------------
create or replace function public.set_user_id()
returns trigger language plpgsql as $$
declare
  owner_id uuid;
begin
  -- Browser writes are always scoped to the workspace owner. For workers this
  -- is the admin who owns their worker row, not the worker auth user. Server-
  -- side admin automation using the service role has no auth.uid() and may
  -- provide an explicit user_id.
  if auth.uid() is not null then
    owner_id := public.workspace_owner_id();
    if owner_id is not null then
      new.user_id = owner_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_time_entries_user on public.time_entries;
create trigger trg_time_entries_user before insert on public.time_entries
  for each row execute function public.set_user_id();

drop trigger if exists trg_active_timers_user on public.active_timers;
create trigger trg_active_timers_user before insert on public.active_timers
  for each row execute function public.set_user_id();

-- ===========================================================================
-- Done. Re-run the STEP 1 query to confirm every row says PASS, then reload
-- the extension in chrome://extensions and try a clock-in.
-- ===========================================================================
