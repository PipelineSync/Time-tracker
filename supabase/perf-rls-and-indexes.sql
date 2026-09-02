-- ============================================================
-- Performance: stop re-evaluating RLS helpers per row, and add
-- the indexes the app's hot queries actually need.
--
-- Safe to run more than once. Changes no permissions or behaviour
-- whatsoever -- every policy grants exactly the same access as
-- before. It only changes HOW OFTEN Postgres evaluates them.
--
-- Run once in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================

-- ------------------------------------------------------------
-- 1. Wrap auth/helper calls in scalar subqueries.
--
-- A bare is_admin() / current_worker_id() / auth.uid() in a policy
-- is re-executed FOR EVERY ROW SCANNED. is_admin() and
-- current_worker_id() each run their own query against profiles,
-- so listing 5,000 time entries ran ~5,000 extra profile lookups.
--
-- Wrapping the call in (select ...) lets the planner treat it as a
-- constant and evaluate it ONCE per statement. This is the standard
-- Supabase RLS optimisation ("initplan" caching).
-- ------------------------------------------------------------

-- ---------- profiles ----------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert with check ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using ((select public.is_admin()) and (select auth.uid()) <> user_id);

-- ---------- workers ----------
drop policy if exists "workers_select" on public.workers;
create policy "workers_select" on public.workers
  for select using ((select auth.uid()) = user_id or id = (select public.current_worker_id()));

drop policy if exists "workers_insert" on public.workers;
create policy "workers_insert" on public.workers
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "workers_update" on public.workers;
create policy "workers_update" on public.workers
  for update using ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "workers_delete" on public.workers;
create policy "workers_delete" on public.workers
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));

-- ---------- time_entries (the biggest table -- biggest win) ----------
drop policy if exists "time_entries_select" on public.time_entries;
create policy "time_entries_select" on public.time_entries
  for select using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "time_entries_insert" on public.time_entries;
create policy "time_entries_insert" on public.time_entries
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (worker_id = (select public.current_worker_id()) and user_id = (select public.workspace_owner_id()))
  );

drop policy if exists "time_entries_update" on public.time_entries;
create policy "time_entries_update" on public.time_entries
  for update using ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "time_entries_delete" on public.time_entries;
create policy "time_entries_delete" on public.time_entries
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));

-- ---------- active_timers ----------
drop policy if exists "active_timers_select" on public.active_timers;
create policy "active_timers_select" on public.active_timers
  for select using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "active_timers_insert" on public.active_timers;
create policy "active_timers_insert" on public.active_timers
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "active_timers_insert_worker" on public.active_timers;
create policy "active_timers_insert_worker" on public.active_timers
  for insert with check (
    worker_id = (select public.current_worker_id())
    and worker_id is not null
    and user_id = (select public.workspace_owner_id())
  );

drop policy if exists "active_timers_update" on public.active_timers;
create policy "active_timers_update" on public.active_timers
  for update using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "active_timers_delete" on public.active_timers;
create policy "active_timers_delete" on public.active_timers
  for delete using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

-- ---------- settings ----------
drop policy if exists "settings_select" on public.settings;
create policy "settings_select" on public.settings
  for select using (user_id = (select public.workspace_owner_id()));

drop policy if exists "settings_insert" on public.settings;
create policy "settings_insert" on public.settings
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "settings_update" on public.settings;
create policy "settings_update" on public.settings
  for update using ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "settings_delete" on public.settings;
create policy "settings_delete" on public.settings
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));

-- ---------- time_entry_comments ----------
drop policy if exists "comments_select" on public.time_entry_comments;
create policy "comments_select" on public.time_entry_comments
  for select using ((select public.is_admin()) or exists (
    select 1 from public.time_entries e
    where e.id = entry_id and e.worker_id = (select public.current_worker_id())
  ));

drop policy if exists "comments_insert" on public.time_entry_comments;
create policy "comments_insert" on public.time_entry_comments
  for insert with check (
    author_id = (select auth.uid())
    and (
      (select public.is_admin())
      or exists (
        select 1 from public.time_entries e
        where e.id = entry_id and e.worker_id = (select public.current_worker_id())
      )
    )
  );

-- ---------- chat_messages ----------
drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select using (user_id = (select public.workspace_owner_id()));

drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert" on public.chat_messages
  for insert with check (
    (select public.is_admin())
    and (select auth.uid()) = user_id
    and (select auth.uid()) = author_id
  );

drop policy if exists "chat_messages_delete" on public.chat_messages;
create policy "chat_messages_delete" on public.chat_messages
  for delete using ((select public.is_admin()) and (select auth.uid()) = user_id);

-- ---------- notifications ----------
drop policy if exists "notifications_select" on public.notifications;
create policy "notifications_select" on public.notifications
  for select using ((select auth.uid()) = user_id);

drop policy if exists "notifications_insert" on public.notifications;
create policy "notifications_insert" on public.notifications
  for insert with check (
    (select public.is_admin())
    or (select auth.uid()) = user_id
    or user_id = (select public.workspace_owner_id())
  );

drop policy if exists "notifications_update" on public.notifications;
create policy "notifications_update" on public.notifications
  for update using ((select auth.uid()) = user_id);

-- ---------- payments ----------
drop policy if exists "payments_select" on public.payments;
create policy "payments_select" on public.payments
  for select using ((select auth.uid()) = user_id or worker_id = (select public.current_worker_id()));

drop policy if exists "payments_insert" on public.payments;
create policy "payments_insert" on public.payments
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "payments_update" on public.payments;
create policy "payments_update" on public.payments
  for update using ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "payments_delete" on public.payments;
create policy "payments_delete" on public.payments
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));


-- ------------------------------------------------------------
-- 2. Indexes for the app's hot paths.
--
-- Every signed-in page load resolves identity via profiles and
-- then lists entries/notifications/payments in a fixed sort order.
-- These match those exact access patterns.
-- ------------------------------------------------------------

-- profiles.worker_id: used by workspace_owner_id(), current_worker_id()
-- and getWorkerUserId() -- i.e. on essentially every request.
create index if not exists profiles_worker_id_idx
  on public.profiles (worker_id);

-- profiles.role: used by is_admin() and the admin lookup fallback.
create index if not exists profiles_role_idx
  on public.profiles (role);

-- listEntries(): order by start_time desc, per workspace or per worker.
create index if not exists time_entries_user_start_idx
  on public.time_entries (user_id, start_time desc);
create index if not exists time_entries_worker_start_idx
  on public.time_entries (worker_id, start_time desc);

-- listNotifications(): where user_id = ? order by created_at desc.
create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- The unread badge count: where user_id = ? and read = false.
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id) where read = false;

-- listPayments(): order by created_at desc, per workspace or per worker.
create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);
create index if not exists payments_worker_created_idx
  on public.payments (worker_id, created_at desc);

-- listActiveTimers(): the worker path filters on user_id (its own slot).
create index if not exists active_timers_user_id_idx
  on public.active_timers (user_id);

-- ------------------------------------------------------------
-- 3. Refresh planner statistics so the new indexes get used now
--    rather than after the next autovacuum.
-- ------------------------------------------------------------
analyze public.profiles;
analyze public.workers;
analyze public.time_entries;
analyze public.active_timers;
analyze public.notifications;
analyze public.payments;
analyze public.chat_messages;
