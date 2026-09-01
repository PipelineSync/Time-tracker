-- Fix worker clock-outs not appearing for the admin.
--
-- Run this once in the Supabase SQL editor for an existing database. It is
-- also incorporated into supabase/schema.sql for fresh installs.

-- Payment notifications were already used by the app, but older schemas did
-- not allow the 'payment' notification type.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('note','time_in','time_out','time_added','payment'));

-- Rows in these tables are workspace-owned by the admin's auth user id. Repair
-- rows that workers created with their own auth user id so admin queries can
-- see them.
update public.time_entries e
set user_id = w.user_id
from public.workers w
where e.worker_id = w.id
  and e.user_id is distinct from w.user_id;

update public.active_timers t
set user_id = w.user_id
from public.workers w
where t.worker_id = w.id
  and t.user_id is distinct from w.user_id;

update public.payments p
set user_id = w.user_id
from public.workers w
where p.worker_id = w.id
  and p.user_id is distinct from w.user_id;

-- Active timers are owned by the workspace admin, so uniqueness must be per
-- worker, not per admin user, or only one worker could be clocked in at once.
-- If retries created duplicate active timers for one worker, keep the newest.
delete from public.active_timers older
using public.active_timers newer
where older.worker_id = newer.worker_id
  and older.start_time < newer.start_time;

drop index if exists public.active_timers_one_per_user;
create unique index if not exists active_timers_one_per_worker on public.active_timers (worker_id);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles
                 where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.current_worker_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select worker_id from public.profiles where user_id = auth.uid();
$$;

create or replace function public.workspace_owner_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.user_id from public.profiles p where p.user_id = auth.uid() and p.role = 'admin'),
    (
      select w.user_id
      from public.profiles p
      join public.workers w on w.id = p.worker_id
      where p.user_id = auth.uid() and p.role = 'worker'
    )
  );
$$;

-- Recreate policies that depend on the workspace owner.
drop policy if exists "time_entries_select" on public.time_entries;
create policy "time_entries_select" on public.time_entries
  for select using (auth.uid() = user_id or worker_id = public.current_worker_id());

drop policy if exists "time_entries_insert" on public.time_entries;
create policy "time_entries_insert" on public.time_entries
  for insert with check (
    (auth.uid() = user_id and public.is_admin())
    or (worker_id = public.current_worker_id() and user_id = public.workspace_owner_id())
  );

drop policy if exists "time_entries_update" on public.time_entries;
create policy "time_entries_update" on public.time_entries
  for update using (auth.uid() = user_id and public.is_admin());

drop policy if exists "time_entries_delete" on public.time_entries;
create policy "time_entries_delete" on public.time_entries
  for delete using (auth.uid() = user_id and public.is_admin());

drop policy if exists "active_timers_select" on public.active_timers;
create policy "active_timers_select" on public.active_timers
  for select using (auth.uid() = user_id or worker_id = public.current_worker_id());

drop policy if exists "active_timers_insert" on public.active_timers;
create policy "active_timers_insert" on public.active_timers
  for insert with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "active_timers_insert_worker" on public.active_timers;
create policy "active_timers_insert_worker" on public.active_timers
  for insert with check (
    worker_id = public.current_worker_id()
    and worker_id is not null
    and user_id = public.workspace_owner_id()
  );

drop policy if exists "active_timers_update" on public.active_timers;
create policy "active_timers_update" on public.active_timers
  for update using (auth.uid() = user_id or worker_id = public.current_worker_id());

drop policy if exists "active_timers_delete" on public.active_timers;
create policy "active_timers_delete" on public.active_timers
  for delete using (auth.uid() = user_id or worker_id = public.current_worker_id());

drop policy if exists "settings_select" on public.settings;
create policy "settings_select" on public.settings
  for select using (user_id = public.workspace_owner_id());

drop policy if exists "payments_select" on public.payments;
create policy "payments_select" on public.payments
  for select using (auth.uid() = user_id or worker_id = public.current_worker_id());

drop policy if exists "comments_select" on public.time_entry_comments;
create policy "comments_select" on public.time_entry_comments
  for select using (public.is_admin() or exists (
    select 1 from public.time_entries e
    where e.id = entry_id and e.worker_id = public.current_worker_id()
  ));

drop policy if exists "comments_insert" on public.time_entry_comments;
create policy "comments_insert" on public.time_entry_comments
  for insert with check (
    author_id = auth.uid()
    and (
      public.is_admin()
      or exists (
        select 1 from public.time_entries e
        where e.id = entry_id and e.worker_id = public.current_worker_id()
      )
    )
  );

drop policy if exists "notifications_insert" on public.notifications;
create policy "notifications_insert" on public.notifications
  for insert with check (
    public.is_admin()
    or auth.uid() = user_id
    or user_id = public.workspace_owner_id()
  );

create or replace function public.set_user_id()
returns trigger language plpgsql as $$
declare
  owner_id uuid;
begin
  if auth.uid() is not null then
    owner_id := public.workspace_owner_id();
    if owner_id is not null then
      new.user_id = owner_id;
    end if;
  end if;
  return new;
end $$;

-- Payments were missing the user_id trigger in older schemas. Without this,
-- Settle & Reset can fail with a not-null/RLS error when creating a payment.
drop trigger if exists trg_payments_user on public.payments;
create trigger trg_payments_user before insert on public.payments
  for each row execute function public.set_user_id();
