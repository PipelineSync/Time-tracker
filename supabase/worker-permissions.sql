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
--   finance.view        finance.manage
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
    'finance.view',
    'finance.manage',
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
      or public.has_permission('finance.view')
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
