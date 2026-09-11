-- ============================================================
-- Work Tracker — Client Invoicing
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Client Invoicing section. New databases get the same statements from
-- supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. adds 'invoices.view' to the allowed permission keys, so the admin can
--      tick "Use the client invoicing board" on a worker
--   2. creates public.invoices — the workspace's invoice board: a client, an
--      amount, when payment is due, which board column it sits in
--      (pending / awaiting / paid) and optional notes
--
-- Access model (mirrors the rest of the app):
--   * the admin (workspace owner) always sees and runs the board
--   * a worker granted `invoices.view` sees and manages the very same board
--   * anyone else cannot read or change the rows, even calling the API
--     directly (RLS is the boundary, the app only mirrors it)
--
-- Prerequisites: supabase/clients.sql (the clients table) and
-- supabase/worker-permissions.sql (has_permission).
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
    'invoices.view',
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

-- ---------- 2. the board ----------
create table if not exists public.invoices (
  id        uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_invoices_user.
  user_id   uuid not null references auth.users (id) on delete cascade,
  -- The client the money is from. Cascade: a deleted client's invoices go
  -- with it — an invoice has nobody left to bill.
  client_id uuid not null references public.clients (id) on delete cascade,
  amount    numeric(12, 2) not null check (amount >= 0),
  -- The day payment is due (a date, not an instant, so timezones cannot move it).
  due_date  date not null,
  -- Board column. Dragging is free movement — forwards to progress an
  -- invoice, backwards to undo — so the only constraint is that the value is
  -- one of the three columns.
  stage     text not null default 'pending' check (stage in ('pending', 'awaiting', 'paid')),
  notes     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The board's exact query: one workspace, due-soonest order.
create index if not exists invoices_user_due_idx on public.invoices (user_id, due_date);
create index if not exists invoices_client_idx on public.invoices (client_id);

alter table public.invoices enable row level security;

-- ---------- policies ----------
drop policy if exists "invoices_select" on public.invoices;
create policy "invoices_select" on public.invoices
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('invoices.view')))
  );

drop policy if exists "invoices_insert" on public.invoices;
create policy "invoices_insert" on public.invoices
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('invoices.view')))
  );

drop policy if exists "invoices_update" on public.invoices;
create policy "invoices_update" on public.invoices
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('invoices.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('invoices.view')))
  );

drop policy if exists "invoices_delete" on public.invoices;
create policy "invoices_delete" on public.invoices
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('invoices.view')))
  );

-- ---------- triggers ----------
drop trigger if exists trg_invoices_user on public.invoices;
create trigger trg_invoices_user before insert on public.invoices
  for each row execute function public.set_user_id();

drop trigger if exists trg_invoices_updated on public.invoices;
create trigger trg_invoices_updated before update on public.invoices
  for each row execute function public.set_updated_at();

-- ---------- verify ----------
-- Expect: the table, then the helper returning t for the admin.
select client_id, amount, due_date, stage from public.invoices order by due_date;
select public.has_permission('invoices.view') as admin_can_use_invoicing;
