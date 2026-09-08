-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  It bundles the two migrations this app is waiting on, in the right order:
--
--    1. CLIENTS          (supabase/clients.sql)
--       the client master list + client_id on tasks / time entries / timers,
--       and a backfill so nothing is left untagged
--
--    2. WORKER ACCESS    (supabase/worker-permissions.sql)
--       workers.permissions + has_permission() + the RLS branches that let a
--       worker the admin has granted a capability actually use it
--
--  Safe to re-run: every statement is idempotent (create ... if not exists /
--  drop-then-create), so running it twice changes nothing and loses no data.
--  A brand-new database created from supabase/schema.sql already has all of
--  this and does not need this file.
--
--  Prerequisite: the Tasks board migration (supabase/RUN-THIS-tasks.sql) must
--  already have been run — Part 1 adds a column to `tasks`. If the app's
--  kanban board works today, you are good.
--
--  The verification queries at the very bottom print what was created.
-- ============================================================================


-- ############################################################################
-- #  PART 1 of 2 — CLIENTS
-- ############################################################################

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


-- ############################################################################
-- #  PART 2 of 2 — PER-WORKER ACCESS
-- ############################################################################

-- ============================================================
-- Work Tracker — per-worker permissions
--
-- Run this in the Supabase SQL editor on an existing database to let the
-- admin hand individual admin capabilities to individual workers. New
-- databases get the same statements from supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. adds workers.permissions — the capabilities the admin ticked for that
--      worker (empty array = a plain worker: their own time, their own board)
--   2. adds public.has_permission(text) — true for the admin (who owns the
--      workspace and therefore holds everything) and for a worker whose row
--      lists that capability
--   3. widens the row level security policies so a granted worker really can
--      read/write the rows their capability covers — and so an ungranted one
--      still cannot, even if they call the REST API directly
--
-- The capability keys match the Permission union in src/lib/types.ts:
--   dashboard.view
--   workers.view        workers.manage
--   entries.view_all    entries.manage
--   tasks.view_all      tasks.manage_all
--   payments.view_all   payments.manage
--   reports.view
--   clients.manage
--   settings.manage
--
-- Note: workers.manage is the most powerful one — like the admin, a worker
-- who can edit workers can also change what other workers (and themselves)
-- are allowed to do. Hand it out accordingly.
-- ============================================================

-- ---------- 1. the column ----------
alter table public.workers
  add column if not exists permissions text[] not null default '{}'::text[];

-- Reject unknown keys, so a typo in a manual UPDATE cannot silently grant
-- nothing (or something the app will never check).
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
    'reports.view',
    'clients.manage',
    'settings.manage'
  ]::text[]
);

-- ---------- 2. the check used by every policy below ----------
-- SECURITY DEFINER so the lookup itself is not filtered by RLS (a worker
-- cannot read other profiles), STABLE so Postgres evaluates it once per query.
create or replace function public.has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    -- The admin owns the workspace: every capability, always.
    (select true
       from public.profiles p
      where p.user_id = auth.uid() and p.role = 'admin'),
    -- A worker holds exactly what the admin ticked on their row.
    (select p_permission = any(w.permissions)
       from public.profiles p
       join public.workers w on w.id = p.worker_id
      where p.user_id = auth.uid() and p.role = 'worker'),
    false
  );
$$;

grant execute on function public.has_permission(text) to authenticated;

-- Anyone who can see team-wide data also needs the names behind it, so the
-- worker list opens for any of the team-wide "view" capabilities — not just
-- workers.view (which is what puts the Workers page in their menu).
create or replace function public.has_team_view()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('workers.view')
      or public.has_permission('dashboard.view')
      or public.has_permission('entries.view_all')
      or public.has_permission('tasks.view_all')
      or public.has_permission('payments.view_all')
      or public.has_permission('reports.view');
$$;

grant execute on function public.has_team_view() to authenticated;

-- ---------- 3. policies ----------
-- Pattern: keep the existing admin / own-rows branches exactly as they were
-- and add one more branch for the granted worker. Rows in this app are owned
-- by the workspace (user_id = workspace_owner_id()), so the extra branch is
-- always "this row belongs to my workspace AND I hold the capability".

-- workers -----------------------------------------------------------------
drop policy if exists "workers_select" on public.workers;
create policy "workers_select" on public.workers
  for select using (
    (select auth.uid()) = user_id
    or id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_team_view()))
  );

drop policy if exists "workers_insert" on public.workers;
create policy "workers_insert" on public.workers
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('workers.manage')))
  );

drop policy if exists "workers_update" on public.workers;
create policy "workers_update" on public.workers
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('workers.manage')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('workers.manage')))
  );

drop policy if exists "workers_delete" on public.workers;
create policy "workers_delete" on public.workers
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('workers.manage')))
  );

-- time_entries ------------------------------------------------------------
drop policy if exists "time_entries_select" on public.time_entries;
create policy "time_entries_select" on public.time_entries
  for select using (
    (select auth.uid()) = user_id
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('entries.view_all')))
  );

drop policy if exists "time_entries_insert" on public.time_entries;
create policy "time_entries_insert" on public.time_entries
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (worker_id = (select public.current_worker_id()) and user_id = (select public.workspace_owner_id()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('entries.manage')))
  );

drop policy if exists "time_entries_update" on public.time_entries;
create policy "time_entries_update" on public.time_entries
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('entries.manage')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('entries.manage')))
  );

drop policy if exists "time_entries_delete" on public.time_entries;
create policy "time_entries_delete" on public.time_entries
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('entries.manage')))
  );

-- active_timers (who is on the clock right now) ---------------------------
drop policy if exists "active_timers_select" on public.active_timers;
create policy "active_timers_select" on public.active_timers
  for select using (
    (select auth.uid()) = user_id
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('entries.view_all')))
  );

-- settings ----------------------------------------------------------------
drop policy if exists "settings_insert" on public.settings;
create policy "settings_insert" on public.settings
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('settings.manage')))
  );

drop policy if exists "settings_update" on public.settings;
create policy "settings_update" on public.settings
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('settings.manage')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('settings.manage')))
  );

-- payments ----------------------------------------------------------------
drop policy if exists "payments_select" on public.payments;
create policy "payments_select" on public.payments
  for select using (
    (select auth.uid()) = user_id
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('payments.view_all')))
  );

drop policy if exists "payments_insert" on public.payments;
create policy "payments_insert" on public.payments
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('payments.manage')))
  );

drop policy if exists "payments_update" on public.payments;
create policy "payments_update" on public.payments
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('payments.manage')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('payments.manage')))
  );

drop policy if exists "payments_delete" on public.payments;
create policy "payments_delete" on public.payments
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('payments.manage')))
  );

-- tasks -------------------------------------------------------------------
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('tasks.view_all')))
  );

-- A worker with tasks.manage_all may put a card on anyone's board.
drop policy if exists "tasks_insert_manager" on public.tasks;
create policy "tasks_insert_manager" on public.tasks
  for insert with check (
    user_id = (select public.workspace_owner_id())
    and (select public.has_permission('tasks.manage_all'))
  );

drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('tasks.manage_all')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('tasks.manage_all')))
  );

drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('tasks.manage_all')))
  );

-- clients (needs supabase/clients.sql; skipped when that table is absent) ---
do $$
begin
  if to_regclass('public.clients') is not null then
    execute $p$
      drop policy if exists "clients_insert_admin" on public.clients;
      create policy "clients_insert_admin" on public.clients
        for insert with check (
          ((select auth.uid()) = user_id and (select public.is_admin()))
          or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('clients.manage')))
        );
    $p$;
    execute $p$
      drop policy if exists "clients_update_admin" on public.clients;
      create policy "clients_update_admin" on public.clients
        for update using (
          ((select auth.uid()) = user_id and (select public.is_admin()))
          or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('clients.manage')))
        )
        with check (
          ((select auth.uid()) = user_id and (select public.is_admin()))
          or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('clients.manage')))
        );
    $p$;
    execute $p$
      drop policy if exists "clients_delete_admin" on public.clients;
      create policy "clients_delete_admin" on public.clients
        for delete using (
          ((select auth.uid()) = user_id and (select public.is_admin()))
          or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('clients.manage')))
        );
    $p$;
  end if;
end
$$;

-- time entry comments (the notes thread on an entry) ----------------------
drop policy if exists "comments_select" on public.time_entry_comments;
create policy "comments_select" on public.time_entry_comments
  for select using (
    (select public.is_admin())
    or (select public.has_permission('entries.view_all'))
    or exists (
      select 1 from public.time_entries e
      where e.id = entry_id and e.worker_id = (select public.current_worker_id())
    )
  );

drop policy if exists "comments_insert" on public.time_entry_comments;
create policy "comments_insert" on public.time_entry_comments
  for insert with check (
    author_id = (select auth.uid())
    and (
      (select public.is_admin())
      or (select public.has_permission('entries.view_all'))
      or exists (
        select 1 from public.time_entries e
        where e.id = entry_id and e.worker_id = (select public.current_worker_id())
      )
    )
  );

-- Done. Existing workers keep an empty permissions array, so nothing changes
-- for anyone until the admin ticks a box in Workers → Edit → Access.


-- ############################################################################
-- #  VERIFY — everything below is read-only
-- ############################################################################

-- 1. The client list, and nothing left untagged (both counts must be 0).
select name, color, status from public.clients order by name;
select
  (select count(*) from public.tasks where client_id is null)        as tasks_without_client,
  (select count(*) from public.time_entries where client_id is null) as entries_without_client;

-- 2. The permissions column exists and every worker starts with no extra
--    access (an empty array) until you tick something in Workers → Access.
select name, status, permissions from public.workers order by name;

-- 3. The two helper functions the policies call.
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('has_permission', 'has_team_view')
order by proname;

-- 4. Row Level Security is on for every table the app writes.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('workers','time_entries','active_timers','settings','payments','tasks','clients','profiles')
order by tablename;
