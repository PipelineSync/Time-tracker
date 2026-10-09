-- ============================================================
-- Work Tracker — Client Invoicing
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Client Invoicing section, or to bring an older one up to date. New databases
-- get the same statements from supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. restates the worker permission allow-list in full (it includes
--      'invoices.view', so the "Use the client invoicing board" tick box saves)
--   2. creates public.invoices — the workspace's invoice board. Each invoice
--      bills one of three things: a regular client (recurring, monthly),
--      a named project (one-time or milestone), or an Upwork client. It has
--      an amount (zero while the figure is still unknown), a due date, a board
--      column (pending / awaiting / paid), notes, and for a regular client its
--      billing cycle (bill_on) and the auto-bill switch
--   3. adds the billing dates (billed_on, paid_on) and backfills them for the
--      invoices already on the board
--   4. keeps one pending cycle per regular client per bill-on date
--
-- Overdue is not stored: an unpaid invoice past its due date is shown as
-- Overdue by the app, so there is no column to keep in step.
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
-- The worker permission allow-list, restated in full: the same list as
-- PERMISSIONS in src/lib/types.ts and the latest check in schema.sql. It
-- includes 'invoices.view', so a worker row may carry the capability and the
-- "Use the client invoicing board" tick box saves. Existing workers keep their
-- permissions; nothing changes for anyone until the admin ticks the box in
-- Workers → Edit → Access.
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
    'settings.manage',
    'it_support.manage',
    'team_kpi.view'
  ]::text[]
);

-- ---------- 2. the board ----------
create table if not exists public.invoices (
  id        uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_invoices_user.
  user_id   uuid not null references auth.users (id) on delete cascade,
  -- The client billed. A regular or Upwork invoice bills the client and always
  -- has one; a project-based one bills its named project and *may* name the
  -- client the project belongs to. Deleting a client clears the link rather
  -- than the row: the app takes the regular and Upwork invoices off the board
  -- (nobody left to bill) and leaves the project-based ones in place.
  client_id uuid references public.clients (id) on delete set null,
  -- What the invoice bills: 'client' (a regular client, billed monthly — the
  -- stored name predates the others), 'project' (a named project) or 'upwork'
  -- (an Upwork client). 'client' is the default so pre-basis rows keep their shape.
  basis     text not null default 'client',
  -- The project billed — set when basis is 'project' (and required then,
  -- enforced by the app), null otherwise.
  project_name text,
  -- Zero is allowed: an invoice can go on the board before its figure is
  -- known and the amount filled in later.
  amount    numeric(12, 2) not null default 0 check (amount >= 0),
  -- The day payment is due (a date, not an instant, so timezones cannot move it).
  due_date  date not null,
  -- Board column. Dragging is free movement — forwards to progress an
  -- invoice, backwards to undo — so the only constraint is that the value is
  -- one of the three columns. Overdue is derived from due_date, not stored.
  stage     text not null default 'pending' check (stage in ('pending', 'awaiting', 'paid')),
  notes     text,
  -- Regular clients only: the cycle date this invoice is raised on. While the
  -- client's auto-bill switch is on it goes out on that day.
  bill_on   date,
  -- Regular clients only: the auto-bill switch. One switch per client — every
  -- regular invoice of the client carries the same value.
  auto_bill boolean not null default false,
  -- Regular clients only: auto-bill has already handled this invoice (raised it,
  -- skipped it when the switch was turned back on, or it was billed by hand while
  -- the switch was on). It is never raised again, so moving it back to Pending
  -- stays a manual call.
  auto_billed boolean not null default false,
  -- The day the invoice was billed (sent) and the day payment was confirmed.
  -- Null until it happens; cleared again on a move back to Pending.
  billed_on date,
  paid_on   date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_basis_valid check (basis in ('client', 'project', 'upwork'))
);

-- Older databases: add the columns the board has grown since the table was
-- first created. Idempotent alters keep this safe to re-run on databases that
-- just created the table above.
alter table public.invoices add column if not exists basis text;
alter table public.invoices add column if not exists project_name text;
alter table public.invoices add column if not exists bill_on date;
alter table public.invoices add column if not exists auto_bill boolean not null default false;
alter table public.invoices add column if not exists auto_billed boolean not null default false;
alter table public.invoices add column if not exists billed_on date;
alter table public.invoices add column if not exists paid_on date;
-- Backfill: every invoice that predates the column bills its client whole.
update public.invoices set basis = 'client' where basis is null;
alter table public.invoices alter column basis set default 'client';
alter table public.invoices alter column basis set not null;
-- A project-based invoice bills a named project on its own — its client_id is
-- null unless it also names the client the project belongs to.
alter table public.invoices alter column client_id drop not null;

-- Backfill in one statement. Every expression reads the row as it was before
-- this script touched it: the updated_at trigger rewrites updated_at on any
-- update, so separate statements would date the later ones to today.
--   * a regular invoice's cycle date is its due date until it has one of its own;
--   * an invoice already billed or paid gets billed_on from the day it was last
--     touched (the nearest record there is), and a paid one gets paid_on the same way.
-- Re-running it changes nothing: the where clause only matches rows still empty.
update public.invoices set
  bill_on   = case when basis = 'client' and bill_on is null then due_date else bill_on end,
  billed_on = case when stage in ('awaiting', 'paid') and billed_on is null then updated_at::date else billed_on end,
  paid_on   = case when stage = 'paid' and paid_on is null then updated_at::date else paid_on end
where (basis = 'client' and bill_on is null)
   or (stage in ('awaiting', 'paid') and billed_on is null)
   or (stage = 'paid' and paid_on is null);

-- Older databases: deleting a client used to cascade its invoices away. Now
-- the link is cleared instead, so a project-based invoice keeps billing its
-- named project while the app removes the regular and Upwork ones (nobody left
-- to bill) before deleting the client. Re-point the foreign key either way.
do $$
declare
  fk record;
begin
  for fk in
    select conname
      from pg_constraint
     where conrelid = 'public.invoices'::regclass
       and confrelid = 'public.clients'::regclass
       and contype = 'f'
  loop
    execute format('alter table public.invoices drop constraint %I', fk.conname);
  end loop;
end $$;
alter table public.invoices
  add constraint invoices_client_id_fkey foreign key (client_id)
  references public.clients (id) on delete set null;

-- The basis check. Databases created by the earlier version of this section
-- carry two checks that only allow client and project: the unnamed one from its
-- table definition (invoices_basis_check) and invoices_basis_valid. Drop both
-- and add the three-value check, named the same on every database.
alter table public.invoices drop constraint if exists invoices_basis_check;
alter table public.invoices drop constraint if exists invoices_basis_valid;
alter table public.invoices add constraint invoices_basis_valid check (basis in ('client', 'project', 'upwork'));

-- The board's exact query: one workspace, due-soonest order.
create index if not exists invoices_user_due_idx on public.invoices (user_id, due_date);
create index if not exists invoices_client_idx on public.invoices (client_id);

-- One pending cycle per regular client per bill-on date: auto-bill queues the
-- next cycle by date, so a second copy of the same cycle is refused by the
-- database too, not only by the app. A database whose existing data already
-- holds such a pair keeps working — the index is simply not created until the
-- pair is resolved and this script is run again.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'invoices_one_pending_cycle'
  ) then
    create unique index invoices_one_pending_cycle
      on public.invoices (user_id, client_id, bill_on)
      where basis = 'client' and stage = 'pending';
  end if;
exception
  when unique_violation then
    raise notice 'invoices_one_pending_cycle was not created: two pending regular invoices of one client share a bill-on date. Resolve them, then run this script again.';
end $$;

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
-- Expect: the table (empty on a fresh install), then has_permission('invoices.view'):
-- true when run as a signed-in admin. The SQL editor runs with no user, so false there is normal.
select client_id, basis, project_name, amount, due_date, stage, bill_on, auto_bill, billed_on, paid_on from public.invoices order by due_date;
select public.has_permission('invoices.view') as admin_can_use_invoicing;
