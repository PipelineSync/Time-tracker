-- ============================================================
-- Work Tracker — One-time expenses for Finance
--
-- Run this once in the Supabase SQL editor on an existing database after
-- supabase/finance.sql. New databases receive the same columns/constraints
-- from supabase/schema.sql. Safe to re-run.
--
-- Adds categorized expense records to finance_items. Each expense is a
-- completed transaction with a date, description and amount; it may optionally
-- be tagged to a client OR to a free-text project (never both). Expense rows
-- use the existing finance.view / finance.manage policies.
-- ============================================================

alter table public.finance_items add column if not exists expense_category text;
alter table public.finance_items add column if not exists client_id uuid;
alter table public.finance_items add column if not exists project_name text;

-- Client tags are nullable so deleting a client never deletes an expense.
-- This is guarded to keep the migration runnable before clients.sql as well.
do $$
begin
  if to_regclass('public.clients') is not null
     and not exists (
       select 1 from pg_constraint
        where conname = 'finance_items_client_id_fkey'
          and conrelid = 'public.finance_items'::regclass
     ) then
    alter table public.finance_items
      add constraint finance_items_client_id_fkey
      foreign key (client_id) references public.clients (id) on delete set null;
  end if;
end
$$;

-- Upgrade the kind vocabulary and keep expenses paid-only. Older rows are
-- unaffected: all existing kinds retain their existing status behavior.
alter table public.finance_items drop constraint if exists finance_items_kind_check;
alter table public.finance_items add constraint finance_items_kind_check
  check (kind in ('subscription','payroll','bill','expense'));

alter table public.finance_items drop constraint if exists finance_items_status_per_kind;
alter table public.finance_items add constraint finance_items_status_per_kind check (
  (kind = 'subscription' and status in ('active','paused'))
  or (kind = 'expense' and status = 'paid')
  or (kind in ('payroll','bill') and status in ('unpaid','paid'))
);

alter table public.finance_items drop constraint if exists finance_items_expense_fields;
alter table public.finance_items add constraint finance_items_expense_fields check (
  (kind = 'expense'
    and expense_category is not null
    and btrim(expense_category) <> ''
    and (client_id is null or project_name is null))
  or (kind <> 'expense'
    and expense_category is null
    and client_id is null
    and project_name is null)
);

alter table public.finance_items drop constraint if exists finance_items_expense_category_length;
alter table public.finance_items add constraint finance_items_expense_category_length
  check (expense_category is null or length(btrim(expense_category)) between 1 and 80);

alter table public.finance_items drop constraint if exists finance_items_project_name_length;
alter table public.finance_items add constraint finance_items_project_name_length
  check (project_name is null or length(btrim(project_name)) between 1 and 120);

create index if not exists finance_items_client_idx on public.finance_items (client_id);
notify pgrst, 'reload schema';

-- ---------- verify ----------
select kind, count(*) as rows, coalesce(sum(amount), 0) as total
  from public.finance_items
 group by kind
 order by kind;

select column_name
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'finance_items'
   and column_name in ('expense_category', 'client_id', 'project_name')
 order by column_name;
