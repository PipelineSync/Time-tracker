-- ============================================================
-- Work Tracker — Meetings
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Meetings section. New databases get the same statements from
-- supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. adds 'meetings.view' to the allowed permission keys, so the admin can
--      tick "Use the meetings section" on a worker
--   2. creates public.meetings — the workspace's schedule: a title, when the
--      meeting starts, and optional notes. No attendees or invites; the
--      agenda simply splits into upcoming and past.
--
-- Access model (mirrors the rest of the app):
--   * the admin (workspace owner) always sees and runs the schedule
--   * a worker granted `meetings.view` sees and manages the very same list
--   * anyone else cannot read or change the rows, even calling the API
--     directly (RLS is the boundary, the app only mirrors it)
--
-- Prerequisite: supabase/worker-permissions.sql (has_permission).
-- ============================================================

-- ---------- 1. the permission key ----------
-- Widen the allow-list so a worker row may carry the new capability. Existing
-- workers keep an empty permissions array, so nothing changes for anyone
-- until the admin ticks the box in Workers → Edit → Access.
alter table public.workers drop constraint if exists workers_permissions_valid;
alter table public.workers add constraint workers_permissions_valid check (
  permissions <@ array[
    'dashboard.view',
    'workers.view',
    'workers.manage',
    'entries.view_all',
    'entries.manage',
    'tasks.view_all',
    'tasks.manage_all',
    'priority_board.view',
    'meetings.view',
    'payments.view_all',
    'payments.manage',
    'finance.view',
    'finance.manage',
    'finance.subscription',
    'finance.payroll',
    'reports.view',
    'clients.manage',
    'settings.manage'
  ]::text[]
);

-- ---------- 2. the schedule ----------
create table if not exists public.meetings (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_meetings_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 200),
  -- Scheduled start.
  start_time timestamptz not null,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The agenda's exact query: one workspace, start order.
create index if not exists meetings_user_start_idx on public.meetings (user_id, start_time);

alter table public.meetings enable row level security;

-- ---------- policies ----------
drop policy if exists "meetings_select" on public.meetings;
create policy "meetings_select" on public.meetings
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_insert" on public.meetings;
create policy "meetings_insert" on public.meetings
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_update" on public.meetings;
create policy "meetings_update" on public.meetings
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_delete" on public.meetings;
create policy "meetings_delete" on public.meetings
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

-- ---------- triggers ----------
drop trigger if exists trg_meetings_user on public.meetings;
create trigger trg_meetings_user before insert on public.meetings
  for each row execute function public.set_user_id();

drop trigger if exists trg_meetings_updated on public.meetings;
create trigger trg_meetings_updated before update on public.meetings
  for each row execute function public.set_updated_at();

-- ---------- verify ----------
-- Expect: the table, then the helper returning t for the admin.
select title, start_time from public.meetings order by start_time;
select public.has_permission('meetings.view') as admin_can_use_meetings;
