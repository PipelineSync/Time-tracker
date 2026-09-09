-- ============================================================
-- Personal Tracker + Task Slack automation
-- Copy this entire file into Supabase SQL Editor and click Run.
-- Safe to run more than once.
-- ============================================================

-- 1) One strictly private personal-finance document per login.
create table if not exists public.personal_finance_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"accounts":[],"categories":[],"sources":[],"incomes":[],"expenses":[],"transfers":[],"recurring":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.personal_finance_data enable row level security;

drop policy if exists "personal_finance_select_own" on public.personal_finance_data;
create policy "personal_finance_select_own" on public.personal_finance_data
  for select using ((select auth.uid()) = user_id);

drop policy if exists "personal_finance_insert_own" on public.personal_finance_data;
create policy "personal_finance_insert_own" on public.personal_finance_data
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "personal_finance_update_own" on public.personal_finance_data;
create policy "personal_finance_update_own" on public.personal_finance_data
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "personal_finance_delete_own" on public.personal_finance_data;
create policy "personal_finance_delete_own" on public.personal_finance_data
  for delete using ((select auth.uid()) = user_id);

revoke all on public.personal_finance_data from anon;
grant select, insert, update, delete on public.personal_finance_data to authenticated;

-- 2) Slack settings. Webhooks remain admin-only secrets.
create table if not exists public.slack_settings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique references auth.users(id) on delete cascade,
  webhook_url          text,
  notify_clock_in      boolean not null default true,
  notify_clock_out     boolean not null default true,
  notify_break_start   boolean not null default true,
  notify_break_end     boolean not null default true,
  notify_payment_paid  boolean not null default true,
  task_webhook_url     text,
  notify_task_created  boolean not null default true,
  notify_task_moved    boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Add task fields to an existing Slack settings table.
alter table public.slack_settings add column if not exists task_webhook_url text;
alter table public.slack_settings add column if not exists notify_task_created boolean not null default true;
alter table public.slack_settings add column if not exists notify_task_moved boolean not null default true;

alter table public.slack_settings enable row level security;

drop policy if exists "slack_settings_admin_all" on public.slack_settings;
create policy "slack_settings_admin_all" on public.slack_settings
  for all
  using ((select public.is_admin()) and (select auth.uid()) = user_id)
  with check ((select public.is_admin()) and (select auth.uid()) = user_id);

drop trigger if exists trg_slack_settings_user on public.slack_settings;
create trigger trg_slack_settings_user before insert on public.slack_settings
  for each row execute function public.set_user_id();

drop trigger if exists trg_slack_settings_updated on public.slack_settings;
create trigger trg_slack_settings_updated before update on public.slack_settings
  for each row execute function public.set_updated_at();

-- Verification: should return both tables with row security enabled.
select relname as table_name, relrowsecurity as rls_enabled
from pg_class
where relname in ('personal_finance_data', 'slack_settings')
order by relname;
