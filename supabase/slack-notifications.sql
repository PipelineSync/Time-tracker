-- ============================================================================
-- Slack notifications (one-time migration for existing databases)
--
-- Adds the `slack_settings` table: the admin's Slack incoming-webhook URL and
-- which events mirror into Slack (clock in / clock out / break start / back
-- from break / payment paid).
--
-- Run this once in the Supabase SQL editor. Fresh installations get the same
-- table from schema.sql automatically.
--
-- The webhook URL is a secret — RLS below lets only the workspace admin read
-- or write this row, so workers can never see it. Slack messages are actually
-- posted server-side by the `slack-notify` Netlify Function, which reads this
-- row (or the SLACK_WEBHOOK_URL environment variable) with the secret key.
-- ============================================================================

create table if not exists public.slack_settings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique references auth.users (id) on delete cascade,
  webhook_url          text,
  notify_clock_in      boolean not null default true,
  notify_clock_out     boolean not null default true,
  notify_break_start   boolean not null default true,
  notify_break_end     boolean not null default true,
  notify_payment_paid  boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.slack_settings enable row level security;

-- Admin only — the webhook URL must never be readable by workers.
drop policy if exists "slack_settings_admin_all" on public.slack_settings;
create policy "slack_settings_admin_all" on public.slack_settings
  for all
  using ((select public.is_admin()) and (select auth.uid()) = user_id)
  with check ((select public.is_admin()) and (select auth.uid()) = user_id);

-- Reuse the schema's auto-fill triggers: user_id = the workspace owner
-- (whoever inserts is the admin themselves) and updated_at on every update.
drop trigger if exists trg_slack_settings_user on public.slack_settings;
create trigger trg_slack_settings_user before insert on public.slack_settings
  for each row execute function public.set_user_id();

drop trigger if exists trg_slack_settings_updated on public.slack_settings;
create trigger trg_slack_settings_updated before update on public.slack_settings
  for each row execute function public.set_updated_at();
