-- ============================================================
-- Work Tracker — Finance (subscriptions, worker payroll, due dates)
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Finance section. New databases get it from supabase/schema.sql, which
-- contains the same statements. Safe to re-run.
--
-- What it does
--   1. creates public.finance_items — the business ledger of recurring
--      subscriptions, per-worker monthly payroll runs and one-off bills,
--      each carrying a due date
--   2. opens it up per permission: the admin always sees everything;
--      a worker sees the ledger only with `finance.view` and may change it
--      only with `finance.manage` — both off by default (admin-only section)
--   3. widens the permission vocabulary (workers_permissions_valid) and
--      has_team_view() with the two new keys, so a finance viewer can also
--      resolve worker names (payroll rows are about people)
--
-- If supabase/worker-permissions.sql has not been applied yet, the table is
-- still created but locked to the admin only — apply that migration and re-run
-- this file to enable per-worker access.
-- ============================================================

create table if not exists public.finance_items (
  id           uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_finance_items_user.
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- What the line is. The whole Finance section reads one table.
  kind         text not null check (kind in ('subscription','payroll','bill')),
  -- Label for subscriptions and bills; payroll rows are named by their worker.
  name         text check (name is null or length(btrim(name)) between 1 and 80),
  -- The worker being paid (payroll only). Deleting the worker removes the run.
  worker_id    uuid references public.workers (id) on delete cascade,
  amount       numeric(12,2) not null default 0 check (amount >= 0),
  -- Billing cycle (subscriptions only).
  cycle        text check (cycle is null or cycle in ('monthly','yearly')),
  -- The month a payroll run covers, 'YYYY-MM' (payroll only).
  period_month text check (period_month is null or period_month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- Next bill date / pay day / deadline. A plain calendar date, like tasks.
  due_date     date not null,
  -- active/paused are subscription states; unpaid/paid the other two.
  status       text not null default 'active'
               check (status in ('active','paused','unpaid','paid')),
  -- When a payroll run or bill was marked paid (subscriptions never use it).
  paid_at      timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Shape rules per kind, so rows written outside the app cannot go rogue.
  constraint finance_items_needs_name check (
    kind = 'payroll' or (name is not null and btrim(name) <> '')
  ),
  constraint finance_items_payroll_fields check (
    (kind = 'payroll' and worker_id is not null and period_month is not null)
    or (kind <> 'payroll' and worker_id is null)
  ),
  constraint finance_items_cycle_only_subs check (
    (kind = 'subscription' and cycle is not null) or (kind <> 'subscription' and cycle is null)
  ),
  constraint finance_items_status_per_kind check (
    (kind = 'subscription' and status in ('active','paused'))
    or (kind <> 'subscription' and status in ('unpaid','paid'))
  ),
  constraint finance_items_paid_stamp check (
    (status = 'paid' and paid_at is not null) or (status <> 'paid' and paid_at is null)
  )
);

create index if not exists finance_items_user_idx on public.finance_items (user_id);
-- The agenda query: one workspace's open lines, oldest due date first.
create index if not exists finance_items_user_due_idx on public.finance_items (user_id, due_date);
-- One payroll run per worker per month.
create unique index if not exists finance_items_payroll_unique
  on public.finance_items (user_id, worker_id, period_month)
  where kind = 'payroll';

alter table public.finance_items enable row level security;

-- ---------- policies ----------
-- With the permission system in place (supabase/worker-permissions.sql) the
-- ledger opens for finance.view / finance.manage holders; without it, the
-- table stays admin-only. The branch is built dynamically so this file works
-- on either kind of database.
do $$
declare
  v_read_check  text;
  v_write_check text;
begin
  if to_regprocedure('public.has_permission(text)') is not null then
    v_read_check  := '(select public.has_permission(''finance.view''))';
    v_write_check := '(select public.has_permission(''finance.manage''))';
  else
    -- No per-worker permissions yet: only the workspace owner reads/writes.
    v_read_check  := 'false';
    v_write_check := '(select public.is_admin())';
  end if;

  execute format($p$
    drop policy if exists "finance_items_select" on public.finance_items;
    create policy "finance_items_select" on public.finance_items
      for select using (
        ((select auth.uid()) = user_id and (select public.is_admin()))
        or (user_id = (select public.workspace_owner_id()) and %s)
      );
  $p$, v_read_check);

  execute format($p$
    drop policy if exists "finance_items_insert" on public.finance_items;
    create policy "finance_items_insert" on public.finance_items
      for insert with check (
        ((select auth.uid()) = user_id and (select public.is_admin()))
        or (user_id = (select public.workspace_owner_id()) and %s)
      );
  $p$, v_write_check);

  execute format($p$
    drop policy if exists "finance_items_update" on public.finance_items;
    create policy "finance_items_update" on public.finance_items
      for update using (
        ((select auth.uid()) = user_id and (select public.is_admin()))
        or (user_id = (select public.workspace_owner_id()) and %s)
      )
      with check (
        ((select auth.uid()) = user_id and (select public.is_admin()))
        or (user_id = (select public.workspace_owner_id()) and %s)
      );
  $p$, v_write_check, v_write_check);

  execute format($p$
    drop policy if exists "finance_items_delete" on public.finance_items;
    create policy "finance_items_delete" on public.finance_items
      for delete using (
        ((select auth.uid()) = user_id and (select public.is_admin()))
        or (user_id = (select public.workspace_owner_id()) and %s)
      );
  $p$, v_write_check);
end
$$;

-- ---------- triggers ----------
-- Own the row by the workspace admin, whoever inserts it.
drop trigger if exists trg_finance_items_user on public.finance_items;
create trigger trg_finance_items_user before insert on public.finance_items
  for each row execute function public.set_user_id();

drop trigger if exists trg_finance_items_updated on public.finance_items;
create trigger trg_finance_items_updated before update on public.finance_items
  for each row execute function public.set_updated_at();

-- ---------- permission vocabulary ----------
-- Teach workers.permissions about the two new keys (when that system exists)
-- and let a finance viewer resolve worker names — payroll rows are about
-- people, and rows without names would be useless.

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'workers' and column_name = 'permissions'
  ) then
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
        'payments.view_all',
        'payments.manage',
        'finance.view',
        'finance.manage',
        'reports.view',
        'clients.manage',
        'settings.manage'
      ]::text[]
    );
  end if;

  if to_regprocedure('public.has_permission(text)') is not null then
    create or replace function public.has_team_view()
    returns boolean
    language sql
    stable
    security definer
    set search_path = public
    as $f$
      select public.has_permission('workers.view')
          or public.has_permission('dashboard.view')
          or public.has_permission('entries.view_all')
          or public.has_permission('tasks.view_all')
          or public.has_permission('payments.view_all')
          or public.has_permission('finance.view')
          or public.has_permission('reports.view');
    $f$;
    grant execute on function public.has_team_view() to authenticated;
  end if;
end
$$;

-- ---------- verify ----------
-- Expect: the finance_items table with RLS on, and its four policies.
select relrowsecurity
from pg_class
where relname = 'finance_items';

select policyname, cmd
from pg_policies
where tablename = 'finance_items'
order by policyname;
