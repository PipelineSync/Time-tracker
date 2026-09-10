-- ============================================================
-- Work Tracker — Client priority board
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Client priority board. New databases get the same statements from
-- supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. adds 'priority_board.view' to the allowed permission keys, so the
--      admin can tick "Use the client priority board" on a worker
--   2. creates public.client_priorities — one row per ranked client: which
--      column ("lane": me / delegated / waiting / low) and its rank inside
--      that column (position, smaller = higher). Clients WITHOUT a row are
--      unranked: the app shows them at the bottom of Low Priority, so new
--      clients land on the board by themselves and "Reset board" simply
--      deletes every row.
--
-- Access model (mirrors the rest of the app):
--   * the admin (workspace owner) always sees and runs the board
--   * a worker granted `priority_board.view` sees and runs the very same
--     board — the columns and ranks are shared, and drag changes are saved
--     for everyone
--   * anyone else cannot read or change the rows, even calling the API
--     directly (RLS is the boundary, the app only mirrors it)
--
-- Prerequisite: supabase/worker-permissions.sql (has_permission) and
-- supabase/clients.sql (the clients table) must already be applied.
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

-- ---------- 2. the board rows ----------
create table if not exists public.client_priorities (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_client_priorities_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- The ranked client. Deleting the client removes its place on the board.
  client_id  uuid not null references public.clients (id) on delete cascade,
  -- Which column of the board the client sits in.
  lane       text not null default 'low' check (lane in ('me','delegated','waiting','low')),
  -- Manual ordering inside the column (smaller sorts first, 0 = top).
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per client per workspace — moving a card updates its row, it never
-- duplicates. The app reports 23505-shaped failures through the normal error
-- path; the upsert-style move in the app reads first, so this is a guard
-- against races, not something users see.
create unique index if not exists client_priorities_user_client_key
  on public.client_priorities (user_id, client_id);

-- The board's exact query: one lane, in rank order.
create index if not exists client_priorities_user_lane_position_idx
  on public.client_priorities (user_id, lane, position);

alter table public.client_priorities enable row level security;

-- ---------- policies ----------
-- The admin and granted workers share one board. Pattern as everywhere else:
-- "this row belongs to my workspace AND I hold the capability" (the admin
-- holds every capability by definition).
drop policy if exists "client_priorities_select" on public.client_priorities;
create policy "client_priorities_select" on public.client_priorities
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_insert" on public.client_priorities;
create policy "client_priorities_insert" on public.client_priorities
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_update" on public.client_priorities;
create policy "client_priorities_update" on public.client_priorities
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_delete" on public.client_priorities;
create policy "client_priorities_delete" on public.client_priorities
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

-- ---------- triggers ----------
-- Own the row by the workspace admin, even when a granted worker drags the
-- card; keep updated_at fresh so a "what changed?" sync picks moves up.
drop trigger if exists trg_client_priorities_user on public.client_priorities;
create trigger trg_client_priorities_user before insert on public.client_priorities
  for each row execute function public.set_user_id();

drop trigger if exists trg_client_priorities_updated on public.client_priorities;
create trigger trg_client_priorities_updated before update on public.client_priorities
  for each row execute function public.set_updated_at();

-- ---------- verify ----------
-- Expect: the table, then the two helper functions returning t for the admin.
select lane, count(*) from public.client_priorities group by lane order by lane;
select public.has_permission('priority_board.view') as admin_can_use_board;
