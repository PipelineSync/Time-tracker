-- ============================================================
-- Work Tracker — Clients (master list) + client tagging
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Clients feature. New databases get it from supabase/schema.sql, which
-- contains the same statements. Safe to re-run.
--
-- What it does
--   1. creates public.clients — the admin's master list of customers, each
--      one active or inactive (only active ones are offered when assigning a
--      task or clocking in; inactive ones keep labelling existing work)
--   2. adds client_id to tasks, time_entries and active_timers
--   3. backfills every existing task/entry to an "Unassigned" client so no
--      work is left without a label
--
-- Access model (mirrors the rest of the app):
--   * the admin (workspace owner) adds / renames / re-colours / retires clients
--   * a worker may READ the list — they need the names and colours for their
--     own board, their filters and their entries — but never change it
-- ============================================================

-- ---------- 1. the master list ----------
create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_clients_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  -- Colour tag used for the client's badge and its slice of the charts.
  color      text not null default 'blue'
             check (color in ('blue','aqua','violet','emerald','amber','orange','rose','slate')),
  -- Inactive clients disappear from the "assign work" dropdowns only.
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clients_user_idx on public.clients (user_id);
create index if not exists clients_user_status_idx on public.clients (user_id, status);
-- One name per workspace, case-insensitively — the app reports 23505 as
-- "…is already on the list."
create unique index if not exists clients_user_name_key
  on public.clients (user_id, lower(btrim(name)));

alter table public.clients enable row level security;

-- ---------- policies ----------
-- Everyone in the workspace reads the list (workers need the labels).
drop policy if exists "clients_select" on public.clients;
create policy "clients_select" on public.clients
  for select using (
    (select auth.uid()) = user_id
    or user_id = (select public.workspace_owner_id())
  );

-- Only the admin maintains it.
drop policy if exists "clients_insert_admin" on public.clients;
create policy "clients_insert_admin" on public.clients
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "clients_update_admin" on public.clients;
create policy "clients_update_admin" on public.clients
  for update using ((select auth.uid()) = user_id and (select public.is_admin()))
  with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "clients_delete_admin" on public.clients;
create policy "clients_delete_admin" on public.clients
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));

-- ---------- triggers ----------
drop trigger if exists trg_clients_user on public.clients;
create trigger trg_clients_user before insert on public.clients
  for each row execute function public.set_user_id();

drop trigger if exists trg_clients_updated on public.clients;
create trigger trg_clients_updated before update on public.clients
  for each row execute function public.set_updated_at();

-- ---------- 2. tag the work ----------
-- on delete set null: a client can only be deleted while unused (the app
-- refuses otherwise), but the constraint keeps history readable regardless.
alter table public.tasks
  add column if not exists client_id uuid references public.clients (id) on delete set null;
alter table public.time_entries
  add column if not exists client_id uuid references public.clients (id) on delete set null;
alter table public.active_timers
  add column if not exists client_id uuid references public.clients (id) on delete set null;

create index if not exists tasks_client_idx on public.tasks (client_id);
create index if not exists time_entries_client_idx on public.time_entries (client_id);

-- ---------- 3. backfill existing work ----------
-- Every workspace that already has tasks or entries without a client gets a
-- single "Unassigned" client, and its untagged rows are pointed at it. The
-- admin can rename it, re-tag the work, or mark it inactive afterwards.
do $$
declare
  owner_id uuid;
  fallback_id uuid;
begin
  for owner_id in
    select user_id from public.tasks where client_id is null
    union
    select user_id from public.time_entries where client_id is null
  loop
    select id into fallback_id
      from public.clients
     where user_id = owner_id and lower(btrim(name)) = 'unassigned'
     limit 1;

    if fallback_id is null then
      insert into public.clients (user_id, name, color, status)
      values (owner_id, 'Unassigned', 'slate', 'active')
      returning id into fallback_id;
    end if;

    update public.tasks
       set client_id = fallback_id
     where user_id = owner_id and client_id is null;

    update public.time_entries
       set client_id = fallback_id
     where user_id = owner_id and client_id is null;
  end loop;
end $$;

-- ---------- verify ----------
-- Expect: the client list, then zero untagged tasks/entries.
select name, color, status from public.clients order by name;
select
  (select count(*) from public.tasks where client_id is null)        as tasks_without_client,
  (select count(*) from public.time_entries where client_id is null) as entries_without_client;
