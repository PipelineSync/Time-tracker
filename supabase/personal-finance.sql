-- Personal Tracker: one strictly private document per authenticated account.
-- Safe to run repeatedly in the Supabase SQL editor.
create table if not exists public.personal_finance_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"accounts":[],"categories":[],"sources":[],"incomes":[],"expenses":[],"transfers":[],"recurring":[]}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.personal_finance_data enable row level security;
drop policy if exists "personal_finance_select_own" on public.personal_finance_data;
create policy "personal_finance_select_own" on public.personal_finance_data for select using ((select auth.uid()) = user_id);
drop policy if exists "personal_finance_insert_own" on public.personal_finance_data;
create policy "personal_finance_insert_own" on public.personal_finance_data for insert with check ((select auth.uid()) = user_id);
drop policy if exists "personal_finance_update_own" on public.personal_finance_data;
create policy "personal_finance_update_own" on public.personal_finance_data for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "personal_finance_delete_own" on public.personal_finance_data;
create policy "personal_finance_delete_own" on public.personal_finance_data for delete using ((select auth.uid()) = user_id);
revoke all on public.personal_finance_data from anon;
grant select, insert, update, delete on public.personal_finance_data to authenticated;
