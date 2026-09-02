-- ============================================================
-- Work Tracker — Supabase schema
-- Run this in the Supabase SQL editor (or via psql) to create
-- all tables, indexes, RLS policies, and triggers.
-- ============================================================

-- Extensions
create extension if not exists "pgcrypto";

-- ---------- workers ----------
create table if not exists public.workers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  email       text,
  hourly_rate numeric(10,2) not null default 0 check (hourly_rate >= 0),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists workers_user_id_idx on public.workers (user_id);

-- ---------- time_entries ----------
create table if not exists public.time_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  worker_id     uuid not null references public.workers (id) on delete cascade,
  project       text,
  start_time    timestamptz not null,
  end_time      timestamptz not null,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  notes         text,
  hourly_rate   numeric(10,2) not null default 0 check (hourly_rate >= 0),
  total_minutes integer not null default 0 check (total_minutes >= 0),
  earnings      numeric(10,2) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- When the entry was included in a settlement ("Settle & reset"), null while
  -- it is still waiting to be settled. Settling never deletes entries — it
  -- stamps the ones it paid for, so the next settlement only covers time worked
  -- since and an entry only disappears when someone deletes it by hand.
  settled_at    timestamptz
);

create index if not exists time_entries_user_id_idx on public.time_entries (user_id);
create index if not exists time_entries_worker_id_idx on public.time_entries (worker_id);
create index if not exists time_entries_start_time_idx on public.time_entries (start_time);
create index if not exists time_entries_worker_settled_idx on public.time_entries (worker_id, settled_at);

-- ---------- active_timers ----------
create table if not exists public.active_timers (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  worker_id     uuid not null references public.workers (id) on delete cascade,
  project       text,
  start_time    timestamptz not null default now(),
  notes         text,
  hourly_rate   numeric(10,2) not null default 0 check (hourly_rate >= 0),
  paused        boolean not null default false,
  pause_start   timestamptz,
  total_pause_ms bigint not null default 0,
  created_at    timestamptz not null default now()
);

-- Enforce only one active timer per worker at the database level. Rows are
-- owned by the workspace admin (user_id), so a user_id unique index would
-- incorrectly prevent multiple workers from clocking in at the same time.
drop index if exists active_timers_one_per_user;
create unique index if not exists active_timers_one_per_worker on public.active_timers (worker_id);
create index if not exists active_timers_worker_id_idx on public.active_timers (worker_id);

-- ---------- time_entry_comments (notes / chat on entries) ----------
create table if not exists public.time_entry_comments (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references public.time_entries (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete cascade,
  author_name text not null,
  author_role text not null default 'worker' check (author_role in ('admin','worker')),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists time_entry_comments_entry_idx on public.time_entry_comments (entry_id);

-- ---------- chat_messages (team chat: one shared room per workspace) ----------
-- The Chat section in the sidebar: the admin and every worker post into the same
-- room. Rows are owned by the workspace admin's user_id (like other admin-owned
-- tables) and snapshot the author's name / role / picture so a message is always
-- attributable, even if the profile changes later.
create table if not exists public.chat_messages (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  author_id         uuid not null references auth.users (id) on delete cascade,
  worker_id         uuid references public.workers (id) on delete cascade,
  author_name       text not null,
  author_role       text not null default 'worker' check (author_role in ('admin','worker')),
  author_position   text,
  author_avatar_url text,
  body              text not null check (length(btrim(body)) between 1 and 2000),
  created_at        timestamptz not null default now()
);

create index if not exists chat_messages_user_created_idx on public.chat_messages (user_id, created_at);
create index if not exists chat_messages_author_idx on public.chat_messages (author_id);

-- ---------- notifications ----------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  entry_id   uuid references public.time_entries (id) on delete cascade,
  type       text not null default 'note' check (type in ('note','time_in','time_out','time_added','payment','break_start','break_end','chat')),
  message    text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id);

-- ---------- payments (settlements) ----------
create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  worker_id    uuid not null references public.workers (id) on delete cascade,
  amount       numeric(10,2) not null default 0,
  hours        numeric(10,2) not null default 0,
  status       text not null default 'unpaid' check (status in ('unpaid','pending','paid')),
  period_start timestamptz not null default now(),
  period_end   timestamptz not null default now(),
  paid_at      timestamptz,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists payments_user_idx on public.payments (user_id);
create index if not exists payments_worker_idx on public.payments (worker_id);

-- ---------- profiles (role model) ----------
-- Each auth user has a profile: 'admin' (owns the workspace) or 'worker'
-- (linked to a worker row). Admin sets hourly rates; workers clock in/out.
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null default 'worker' check (role in ('admin','worker')),
  worker_id  uuid references public.workers (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- settings ----------
create table if not exists public.settings (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references auth.users (id) on delete cascade,
  business_name       text not null default 'My Business',
  currency            text not null default 'USD',
  timezone            text not null default 'UTC',
  default_hourly_rate numeric(10,2) not null default 20 check (default_hourly_rate >= 0),
  updated_at          timestamptz not null default now()
);

-- ============================================================
-- Row Level Security (role-based)
-- Admin owns the workspace (rows carry the admin's user_id).
-- Workers can read their own profile & entries and manage their
-- own clock-in timer. Only the admin can create/edit workers,
-- set rates, and manage manual entries / settings.
-- ============================================================
alter table public.workers       enable row level security;
alter table public.time_entries  enable row level security;
alter table public.active_timers enable row level security;
alter table public.settings      enable row level security;
alter table public.profiles      enable row level security;
alter table public.time_entry_comments enable row level security;
alter table public.notifications      enable row level security;
alter table public.payments           enable row level security;
alter table public.chat_messages          enable row level security;

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

-- Resolve the admin user_id that owns the current signed-in user's workspace.
-- Admin-owned tables keep user_id set to this workspace owner, even when a
-- worker creates a timer/entry from their own login. This lets the admin see
-- worker clock-outs in Dashboard, Time Entries, and Reports.
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

-- profiles policies (users read their own profile; admin can read all)
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (auth.uid() = user_id or public.is_admin());

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (auth.uid() = user_id or public.is_admin());

-- Admin may remove other accounts' profile rows (never their own) when a
-- worker is deleted. The matching auth user is removed server-side by the
-- delete-worker Netlify function.
drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using (public.is_admin() and auth.uid() <> user_id);

-- workers policies
drop policy if exists "workers_select" on public.workers;
create policy "workers_select" on public.workers
  for select using (auth.uid() = user_id or id = public.current_worker_id());

drop policy if exists "workers_insert" on public.workers;
create policy "workers_insert" on public.workers
  for insert with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "workers_update" on public.workers;
create policy "workers_update" on public.workers
  for update using (auth.uid() = user_id and public.is_admin());

drop policy if exists "workers_delete" on public.workers;
create policy "workers_delete" on public.workers
  for delete using (auth.uid() = user_id and public.is_admin());

-- time_entries policies
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

-- active_timers policies (admin full; worker only their own clock-in)
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

-- settings policies (admin only for writes; workers may read)
drop policy if exists "settings_select" on public.settings;
create policy "settings_select" on public.settings
  for select using (user_id = public.workspace_owner_id());

drop policy if exists "settings_insert" on public.settings;
create policy "settings_insert" on public.settings
  for insert with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "settings_update" on public.settings;
create policy "settings_update" on public.settings
  for update using (auth.uid() = user_id and public.is_admin());

drop policy if exists "settings_delete" on public.settings;
create policy "settings_delete" on public.settings
  for delete using (auth.uid() = user_id and public.is_admin());

-- time_entry_comments policies (admin all; worker only comments on their own entries)
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

-- chat_messages policies — one shared room per workspace: the admin and every
-- worker of that workspace read the same messages; posting happens through the
-- post_chat_message() RPC (see below), so there is no open insert policy for
-- clients. The admin can clear the room (also used by "Delete all data").
drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select using (user_id = public.workspace_owner_id());

drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert" on public.chat_messages
  for insert with check (public.is_admin() and auth.uid() = user_id and auth.uid() = author_id);

drop policy if exists "chat_messages_delete" on public.chat_messages;
create policy "chat_messages_delete" on public.chat_messages
  for delete using (public.is_admin() and auth.uid() = user_id);

-- notifications policies (users manage their own notifications)
drop policy if exists "notifications_select" on public.notifications;
create policy "notifications_select" on public.notifications
  for select using (auth.uid() = user_id);

drop policy if exists "notifications_insert" on public.notifications;
create policy "notifications_insert" on public.notifications
  for insert with check (
    public.is_admin()
    or auth.uid() = user_id
    or user_id = public.workspace_owner_id()
  );

drop policy if exists "notifications_update" on public.notifications;
create policy "notifications_update" on public.notifications
  for update using (auth.uid() = user_id);

-- payments policies (admin full; worker reads own)
drop policy if exists "payments_select" on public.payments;
create policy "payments_select" on public.payments
  for select using (auth.uid() = user_id or worker_id = public.current_worker_id());

drop policy if exists "payments_insert" on public.payments;
create policy "payments_insert" on public.payments
  for insert with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "payments_update" on public.payments;
create policy "payments_update" on public.payments
  for update using (auth.uid() = user_id and public.is_admin());

drop policy if exists "payments_delete" on public.payments;
create policy "payments_delete" on public.payments
  for delete using (auth.uid() = user_id and public.is_admin());

-- ============================================================
-- Auto-set user_id and updated_at
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create or replace function public.set_user_id()
returns trigger language plpgsql as $$
declare
  owner_id uuid;
begin
  -- Browser writes are always scoped to the workspace owner. For workers this
  -- is the admin who owns their worker row, not the worker auth user. Server-
  -- side admin automation using the service role has no auth.uid() and may
  -- provide an explicit user_id.
  if auth.uid() is not null then
    owner_id := public.workspace_owner_id();
    if owner_id is not null then
      new.user_id = owner_id;
    end if;
  end if;
  return new;
end $$;

-- Auto-assign user_id on insert where the client didn't (defense in depth).
drop trigger if exists trg_workers_user on public.workers;
create trigger trg_workers_user before insert on public.workers
  for each row execute function public.set_user_id();

drop trigger if exists trg_time_entries_user on public.time_entries;
create trigger trg_time_entries_user before insert on public.time_entries
  for each row execute function public.set_user_id();

drop trigger if exists trg_active_timers_user on public.active_timers;
create trigger trg_active_timers_user before insert on public.active_timers
  for each row execute function public.set_user_id();

drop trigger if exists trg_settings_user on public.settings;
create trigger trg_settings_user before insert on public.settings
  for each row execute function public.set_user_id();

drop trigger if exists trg_payments_user on public.payments;
create trigger trg_payments_user before insert on public.payments
  for each row execute function public.set_user_id();

drop trigger if exists trg_chat_messages_user on public.chat_messages;
create trigger trg_chat_messages_user before insert on public.chat_messages
  for each row execute function public.set_user_id();

drop trigger if exists trg_workers_updated on public.workers;
create trigger trg_workers_updated before update on public.workers
  for each row execute function public.set_updated_at();

drop trigger if exists trg_time_entries_updated on public.time_entries;
create trigger trg_time_entries_updated before update on public.time_entries
  for each row execute function public.set_updated_at();

drop trigger if exists trg_settings_updated on public.settings;
create trigger trg_settings_updated before update on public.settings
  for each row execute function public.set_updated_at();

-- Account customization fields (safe migration for existing installations)
alter table public.workers add column if not exists position text;
alter table public.workers add column if not exists avatar_url text;
alter table public.settings add column if not exists avatar_url text;

-- Worker self-service profile picture.
-- Workers cannot UPDATE their own `workers` row directly (the RLS update policy
-- is admin-only so they cannot tamper with their hourly rate / status). This
-- SECURITY DEFINER RPC lets the signed-in worker change ONLY the avatar on
-- their own row.
create or replace function public.update_own_avatar(new_avatar text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  wid uuid;
begin
  select worker_id into wid
    from public.profiles
   where user_id = auth.uid();
  if wid is null then
    raise exception 'No worker account is linked to this user.';
  end if;
  update public.workers
     set avatar_url = nullif(new_avatar, ''),
         updated_at = now()
   where id = wid;
  if not found then
    raise exception 'Worker not found.';
  end if;
end;
$$;

revoke all on function public.update_own_avatar(text) from public, anon;
grant execute on function public.update_own_avatar(text) to authenticated;

-- ============================================================
-- Team chat helpers
-- ============================================================

-- Post a message into the workspace chat. Author identity (name / role /
-- position / profile picture) is resolved from auth.uid(), never from the
-- request, so nobody can post as the admin or another teammate.
create or replace function public.post_chat_message(message_body text)
returns public.chat_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  caller_role text;
  wid         uuid;
  owner_id    uuid;
  v_name      text;
  v_position  text;
  v_avatar    text;
  v_body      text := btrim(coalesce(message_body, ''));
  result      public.chat_messages;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;
  if v_body = '' then
    raise exception 'Write a message first.';
  end if;
  if length(v_body) > 2000 then
    raise exception 'Message is too long (2000 characters max).';
  end if;

  select p.role, p.worker_id into caller_role, wid
    from public.profiles p
   where p.user_id = me;
  if caller_role is null then
    raise exception 'No account profile found for this user.';
  end if;

  owner_id := public.workspace_owner_id();

  if caller_role = 'admin' then
    v_name := 'Admin';
    v_position := 'Owner';
    select s.avatar_url into v_avatar
      from public.settings s
     where s.user_id = me
     limit 1;
  else
    if wid is null then
      raise exception 'No worker account is linked to this user.';
    end if;
    select w.name, w.position, w.avatar_url into v_name, v_position, v_avatar
      from public.workers w
     where w.id = wid;
    if v_name is null then
      raise exception 'Worker profile not found.';
    end if;
  end if;

  insert into public.chat_messages (
    user_id, author_id, worker_id, author_name, author_role,
    author_position, author_avatar_url, body
  ) values (
    owner_id, me, case when caller_role = 'admin' then null else wid end,
    v_name, caller_role, v_position, v_avatar, v_body
  )
  returning * into result;

  return result;
end;
$$;

revoke all on function public.post_chat_message(text) from public, anon;
grant execute on function public.post_chat_message(text) to authenticated;

-- Roster for the Chat page's "See all members" button, including the admin.
-- Workers may not read other members' rows under RLS, so this SECURITY DEFINER
-- function returns the roster of the caller's own workspace only.
create or replace function public.workspace_members()
returns table (
  worker_id       uuid,
  user_id         uuid,
  full_name       text,
  member_role     text,
  member_position text,
  avatar_url      text,
  worker_status   text
)
language sql
stable
security definer
set search_path = public
as $$
  select null::uuid     as worker_id,
         p.user_id       as user_id,
         'Admin'         as full_name,
         'admin'         as member_role,
         'Owner'         as member_position,
         s.avatar_url    as avatar_url,
         null::text      as worker_status
    from public.profiles p
    left join public.settings s on s.user_id = p.user_id
   where p.role = 'admin'
     and p.user_id = public.workspace_owner_id()
  union all
  select w.id           as worker_id,
         p.user_id       as user_id,
         w.name          as full_name,
         'worker'        as member_role,
         w.position      as member_position,
         w.avatar_url    as avatar_url,
         w.status        as worker_status
    from public.workers w
    left join public.profiles p on p.worker_id = w.id
   where w.user_id = public.workspace_owner_id()
   order by 3;
$$;

revoke all on function public.workspace_members() from public, anon;
grant execute on function public.workspace_members() to authenticated;

-- Notify the rest of the workspace about a new team-chat message. One row per
-- member except the author, worded like the client's chatNotificationText().
-- SECURITY DEFINER because under RLS a worker may only insert notifications for
-- themselves and the workspace admin, never for the other workers.
create or replace function public.notify_chat_message(p_chat_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  msg      public.chat_messages;
  preview  text;
  inserted integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select * into msg from public.chat_messages where id = p_chat_id;
  if not found then
    raise exception 'Chat message not found.';
  end if;
  -- Only the author notifies about their own message.
  if msg.author_id <> auth.uid() then
    raise exception 'You can only notify about your own message.';
  end if;

  preview := btrim(regexp_replace(msg.body, '\s+', ' ', 'g'));
  if length(preview) > 120 then
    preview := left(preview, 119) || '…';
  end if;

  insert into public.notifications (user_id, entry_id, type, message)
  select m.user_id, null, 'chat', msg.author_name || ': ' || preview
    from public.workspace_members() as m
   where m.user_id is not null
     and m.user_id <> msg.author_id;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.notify_chat_message(uuid) from public, anon;
grant execute on function public.notify_chat_message(uuid) to authenticated;
