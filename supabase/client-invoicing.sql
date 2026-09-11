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
--   2. creates public.invoices — the workspace's invoice board: a client,
--      whether it bills the whole client or one named project, an amount
--      (zero while the figure is still unknown), when payment is due, which
--      board column it sits in (pending / awaiting / paid) and optional notes
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
  -- The client billed — set on a client-based invoice, null on a
  -- project-based one (client and project are different billing targets,
  -- never both). Cascade: a deleted client's client-based invoices go with
  -- it — an invoice has nobody left to bill.
  client_id uuid references public.clients (id) on delete cascade,
  -- What the invoice bills: a client, or a named project on its own. 'client'
  -- is the default so pre-basis rows keep their shape.
  basis     text not null default 'client' check (basis in ('client', 'project')),
  -- The project billed — set when basis is 'project' (and required then,
  -- enforced by the app), null for client-based invoices.
  project_name text,
  -- Zero is allowed: an invoice can go on the board before its figure is
  -- known and the amount filled in later.
  amount    numeric(12, 2) not null default 0 check (amount >= 0),
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

-- Older databases: add the billing basis and project name, and let
-- project-based invoices exist without a client. Idempotent alters keep
-- this safe to re-run on databases that just created the table above.
alter table public.invoices add column if not exists basis text;
alter table public.invoices add column if not exists project_name text;
-- Backfill: every invoice that predates the column bills its client whole.
update public.invoices set basis = 'client' where basis is null;
alter table public.invoices alter column basis set default 'client';
alter table public.invoices alter column basis set not null;
-- A project-based invoice bills a named project, not a client — its
-- client_id is null.
alter table public.invoices alter column client_id drop not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.invoices'::regclass
       and conname in ('invoices_basis_valid', 'invoices_basis_check')
  ) then
    alter table public.invoices add constraint invoices_basis_valid check (basis in ('client', 'project'));
  end if;
end $$;

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
select client_id, basis, project_name, amount, due_date, stage from public.invoices order by due_date;
select public.has_permission('invoices.view') as admin_can_use_invoicing;
