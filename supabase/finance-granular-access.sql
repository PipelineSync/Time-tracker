-- ============================================================
-- Work Tracker — Granular Finance access (View subscriptions / View payroll)
-- ------------------------------------------------------------
-- The Access form on the Workers page offers two granular Finance view keys:
--   finance.subscription  — read access, the app shows only the Subscriptions tab
--   finance.payroll       — read access, the app shows only the Payroll tab
--
-- Databases built from supabase/schema.sql already honour both keys (the
-- permission allow-list, has_team_view() and the finance_items read policy
-- all include them). This file brings EXISTING databases to the same state.
-- Run the whole file once in the Supabase SQL editor. Safe to re-run —
-- every statement is idempotent and guarded so it also works on databases
-- that never ran the per-worker-permissions migration (it then does nothing).
--
-- What it does:
--   1. Widens workers.permissions' allow-list with the two keys (so saving
--      the Access tick boxes no longer reports "Finance access was not saved").
--   2. Widens public.has_team_view() — anyone holding a granular Finance key
--      may also read the worker list (payroll rows are about people; rows
--      without names would be useless).
--   3. Widens the finance_items SELECT policy so a granular viewer actually
--      receives rows (the app shows them only their own tab; writes still
--      require finance.manage, untouched here).
-- ============================================================

-- ---------- 1. permission allow-list ----------
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
  end if;
end
$$;

-- ---------- 2. worker-list visibility for granular viewers ----------
do $$
begin
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
          or public.has_permission('finance.subscription')
          or public.has_permission('finance.payroll')
          or public.has_permission('reports.view');
    $f$;
    grant execute on function public.has_team_view() to authenticated;
  end if;
end
$$;

-- ---------- 3. finance ledger read policy ----------
do $$
begin
  if to_regclass('public.finance_items') is not null
     and to_regprocedure('public.has_permission(text)') is not null then
    drop policy if exists "finance_items_select" on public.finance_items;
    create policy "finance_items_select" on public.finance_items
      for select using (
        ((select auth.uid()) = user_id and (select public.is_admin()))
        or (user_id = (select public.workspace_owner_id())
            and (select public.has_permission('finance.view')
                 or public.has_permission('finance.subscription')
                 or public.has_permission('finance.payroll')))
      );
  end if;
end
$$;

-- ---------- verify ----------
-- Expect one row: true, true — the allow-list and the team-view function
-- both know the two granular keys now.
select
  (consrc like '%finance.subscription%' and consrc like '%finance.payroll%') as allow_list_has_granular_keys,
  (prosrc like '%finance.subscription%' and prosrc like '%finance.payroll%') as team_view_has_granular_keys
from pg_constraint cross join pg_proc
where conname = 'workers_permissions_valid'
  and pg_proc.oid = to_regprocedure('public.has_team_view');

-- Functional check (run as a signed-in worker holding one of the keys):
--   select count(*) from public.finance_items;  -- rows are visible now
