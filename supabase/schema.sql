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
  -- Start of the *current client segment* (resets on Switch client).
  start_time    timestamptz not null default now(),
  -- Original clock-in for the whole shift (stays put across client switches so
  -- the on-screen timer keeps counting). See supabase/switch-client-session.sql.
  session_start timestamptz,
  -- Working ms already split into finished entries earlier in this shift.
  prior_worked_ms bigint not null default 0,
  notes         text,
  hourly_rate   numeric(10,2) not null default 0 check (hourly_rate >= 0),
  paused        boolean not null default false,
  pause_start   timestamptz,
  total_pause_ms bigint not null default 0,
  created_at    timestamptz not null default now()
);

-- Safe migration for databases created before session_start/prior_worked_ms.
alter table public.active_timers add column if not exists session_start timestamptz;
alter table public.active_timers add column if not exists prior_worked_ms bigint not null default 0;

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

-- ---------- chat_reactions (emoji reactions on chat messages) ----------
-- One row per (message, member, emoji): a member can react with several emoji,
-- but never twice with the same one — the client sends it again to take it back.
-- Reactions never notify; see supabase/chat-reactions.sql for the rationale.
create table if not exists public.chat_reactions (
  id          uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin), like chat_messages. Set by trg_chat_reactions_user.
  user_id     uuid not null references auth.users (id) on delete cascade,
  message_id  uuid not null references public.chat_messages (id) on delete cascade,
  author_id   uuid not null references auth.users (id) on delete cascade,
  author_name text not null,
  emoji       text not null check (char_length(emoji) between 1 and 8),
  created_at  timestamptz not null default now(),
  unique (message_id, author_id, emoji)
);

create index if not exists chat_reactions_message_idx on public.chat_reactions (message_id);
create index if not exists chat_reactions_user_created_idx on public.chat_reactions (user_id, created_at);

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
  -- How the admin paid (cash / qr), chosen from the worker's accepted methods
  -- when the payment is marked paid. Null until then.
  payment_method text check (payment_method is null or payment_method in ('cash','qr')),
  created_at   timestamptz not null default now()
);
-- Databases created before payment_method existed.
alter table public.payments add column if not exists payment_method text
  check (payment_method is null or payment_method in ('cash','qr'));

create index if not exists payments_user_idx on public.payments (user_id);
create index if not exists payments_worker_idx on public.payments (worker_id);

-- ---------- tasks (kanban board) ----------
-- The Tasks section: a worker sees/manages only their own cards, the admin
-- sees every worker's. Rows are owned by the workspace admin (user_id) like
-- time_entries, so a task a worker creates from their own login still shows on
-- the admin's board. See supabase/tasks.sql for existing databases.
create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  worker_id       uuid not null references public.workers (id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 200),
  description     text,
  status          text not null default 'todo' check (status in ('todo','in_progress','waiting','approval','completed')),
  priority        text not null default 'medium' check (priority in ('low','medium','high')),
  due_date        date,
  -- Manual ordering inside a column (smaller sorts first).
  position        integer not null default 0,
  created_by_role text not null default 'worker' check (created_by_role in ('admin','worker')),
  -- When it first reached the Completed column (cleared if it moves back).
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tasks_user_idx on public.tasks (user_id);
create index if not exists tasks_worker_idx on public.tasks (worker_id);
create index if not exists tasks_worker_status_position_idx
  on public.tasks (worker_id, status, position);

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
alter table public.chat_reactions         enable row level security;
alter table public.tasks                  enable row level security;

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
  for select using ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "profiles_insert" on public.profiles;
create policy "profiles_insert" on public.profiles
  for insert with check ((select auth.uid()) = user_id or (select public.is_admin()));

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using ((select auth.uid()) = user_id or (select public.is_admin()));

-- Admin may remove other accounts' profile rows (never their own) when a
-- worker is deleted. The matching auth user is removed server-side by the
-- delete-worker Netlify function.
drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using ((select public.is_admin()) and (select auth.uid()) <> user_id);

-- workers policies
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

-- time_entries policies
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

-- active_timers policies (admin full; worker only their own clock-in)
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

-- settings policies (admin only for writes; workers may read)
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

-- time_entry_comments policies (admin all; worker only comments on their own entries)
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

-- chat_messages policies — one shared room per workspace: the admin and every
-- worker of that workspace read the same messages; posting happens through the
-- post_chat_message() RPC (see below), so there is no open insert policy for
-- clients. The admin can clear the room (also used by "Delete all data").
drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select using (user_id = (select public.workspace_owner_id()));

drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert" on public.chat_messages
  for insert with check ((select public.is_admin()) and (select auth.uid()) = user_id and (select auth.uid()) = author_id);

drop policy if exists "chat_messages_delete" on public.chat_messages;
create policy "chat_messages_delete" on public.chat_messages
  for delete using ((select public.is_admin()) and (select auth.uid()) = user_id);

-- chat_reactions policies — the whole workspace reads the same reactions.
-- Toggling happens through toggle_chat_reaction() (below, security definer), so
-- there is no insert policy for clients; the admin may clear them with the room.
drop policy if exists "chat_reactions_select" on public.chat_reactions;
create policy "chat_reactions_select" on public.chat_reactions
  for select using (user_id = (select public.workspace_owner_id()));

drop policy if exists "chat_reactions_delete" on public.chat_reactions;
create policy "chat_reactions_delete" on public.chat_reactions
  for delete using ((select public.is_admin()) and (select auth.uid()) = user_id);

-- notifications policies (users manage their own notifications)
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

-- payments policies (admin full; worker reads own)
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

-- tasks policies (admin: every worker's board; worker: only their own cards)
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

drop policy if exists "tasks_insert_admin" on public.tasks;
create policy "tasks_insert_admin" on public.tasks
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

-- A worker may add tasks, but only ever assigned to themselves.
drop policy if exists "tasks_insert_worker" on public.tasks;
create policy "tasks_insert_worker" on public.tasks
  for insert with check (
    worker_id = (select public.current_worker_id())
    and worker_id is not null
    and user_id = (select public.workspace_owner_id())
  );

drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

-- ============================================================
-- Performance indexes for the app's hot query paths
-- (see supabase/perf-rls-and-indexes.sql for existing databases)
-- ============================================================
create index if not exists profiles_worker_id_idx on public.profiles (worker_id);
create index if not exists profiles_role_idx on public.profiles (role);
create index if not exists time_entries_user_start_idx on public.time_entries (user_id, start_time desc);
create index if not exists time_entries_worker_start_idx on public.time_entries (worker_id, start_time desc);
create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx on public.notifications (user_id) where read = false;
create index if not exists payments_user_created_idx on public.payments (user_id, created_at desc);
create index if not exists payments_worker_created_idx on public.payments (worker_id, created_at desc);
create index if not exists active_timers_user_id_idx on public.active_timers (user_id);

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

drop trigger if exists trg_chat_reactions_user on public.chat_reactions;
create trigger trg_chat_reactions_user before insert on public.chat_reactions
  for each row execute function public.set_user_id();

drop trigger if exists trg_tasks_user on public.tasks;
create trigger trg_tasks_user before insert on public.tasks
  for each row execute function public.set_user_id();

drop trigger if exists trg_tasks_updated on public.tasks;
create trigger trg_tasks_updated before update on public.tasks
  for each row execute function public.set_updated_at();

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

-- Worker-chosen payment methods ('cash' and/or 'qr') plus the QR code image
-- (data URL) a worker uploads when they accept QR Code payments.
alter table public.workers add column if not exists payment_methods text[] not null default '{}';
alter table public.workers add column if not exists qr_code_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workers_payment_methods_check'
  ) then
    alter table public.workers
      add constraint workers_payment_methods_check
      check (payment_methods <@ array['cash','qr']::text[]);
  end if;
end $$;

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

-- Worker self-service payment methods. Workers cannot UPDATE their own
-- `workers` row directly (the RLS update policy is admin-only). This SECURITY
-- DEFINER RPC lets the signed-in worker change ONLY the payment fields (which
-- methods they accept and their QR code image) on their own row. QR Code
-- requires the image; turning QR off clears it.
create or replace function public.update_own_payment_methods(
  p_methods text[],
  p_qr_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  wid      uuid;
  methods  text[];
  qr_url   text;
begin
  select worker_id into wid
    from public.profiles
   where user_id = auth.uid();
  if wid is null then
    raise exception 'No worker account is linked to this user.';
  end if;

  methods := array(
    select distinct m
      from unnest(coalesce(p_methods, '{}'::text[])) as m
     where m in ('cash', 'qr')
     order by 1
  );

  if array_length(methods, 1) is null then
    raise exception 'Choose at least one payment method.';
  end if;

  if 'qr' = any(methods) then
    qr_url := nullif(btrim(coalesce(p_qr_code, '')), '');
    if qr_url is null then
      select qr_code_url into qr_url
        from public.workers
       where id = wid;
    end if;
    if qr_url is null then
      raise exception 'Upload your QR code image to accept QR Code payments.';
    end if;
  else
    qr_url := null;
  end if;

  update public.workers
     set payment_methods = methods,
         qr_code_url = qr_url,
         updated_at = now()
   where id = wid;
  if not found then
    raise exception 'Worker not found.';
  end if;
end;
$$;

revoke all on function public.update_own_payment_methods(text[], text) from public, anon;
grant execute on function public.update_own_payment_methods(text[], text) to authenticated;

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

  -- A sticker is a token in the body; announce it as "[sticker]" instead.
  preview := btrim(regexp_replace(regexp_replace(msg.body, '\[sticker:[a-z0-9-]+\]', '[sticker]', 'g'), '\s+', ' ', 'g'));
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

-- ============================================================
-- Team chat reactions (see supabase/chat-reactions.sql)
-- ============================================================

-- The whole workspace's reactions for the messages the client already has.
create or replace function public.list_chat_reactions()
returns setof public.chat_reactions
language sql
stable
security definer
set search_path = public
as $$
  select r.*
    from public.chat_reactions r
   where r.user_id = public.workspace_owner_id()
   order by r.created_at;
$$;

revoke all on function public.list_chat_reactions() from public, anon;
grant execute on function public.list_chat_reactions() to authenticated;

-- Add the emoji to the message, or remove it when it is already there. The
-- reactor is auth.uid() and the message must belong to the caller's workspace,
-- so neither can be forged by a client. Returns the message's reactions.
create or replace function public.toggle_chat_reaction(message_id uuid, reaction_emoji text)
returns setof public.chat_reactions
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  owner_id    uuid;
  caller_role text;
  wid         uuid;
  v_name      text;
  v_emoji     text := btrim(coalesce(reaction_emoji, ''));
  -- Local copies: inside plpgsql a bare message_id would also match the column.
  v_message   uuid := toggle_chat_reaction.message_id;
  target      public.chat_messages;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;
  if v_emoji = '' then
    raise exception 'Pick an emoji first.';
  end if;
  if char_length(v_emoji) > 8 then
    raise exception 'A reaction is a single emoji.';
  end if;

  select * into target from public.chat_messages m where m.id = v_message;
  if not found then
    raise exception 'That message is no longer there.';
  end if;

  owner_id := public.workspace_owner_id();
  if target.user_id is distinct from owner_id then
    raise exception 'That message is not in your workspace.';
  end if;

  select p.role, p.worker_id into caller_role, wid
    from public.profiles p
   where p.user_id = me;
  if caller_role = 'admin' then
    v_name := 'Admin';
  else
    select w.name into v_name from public.workers w where w.id = wid;
  end if;
  if v_name is null then
    v_name := 'Member';
  end if;

  delete from public.chat_reactions r
    where r.message_id = v_message
      and r.author_id = me
      and r.emoji = v_emoji;

  if not found then
    insert into public.chat_reactions (user_id, message_id, author_id, author_name, emoji)
    values (owner_id, v_message, me, v_name, v_emoji);
  end if;

  return query
    select r.*
      from public.chat_reactions r
     where r.message_id = v_message
     order by r.created_at;
end;
$$;

revoke all on function public.toggle_chat_reaction(uuid, text) from public, anon;
grant execute on function public.toggle_chat_reaction(uuid, text) to authenticated;

-- ============================================================
-- Slack notifications (Settings → Slack)
-- ============================================================
-- The admin's Slack incoming-webhook URL + which events mirror into Slack.
-- Admin-only RLS: the webhook URL is never readable by workers — Slack
-- messages are posted server-side by the `slack-notify` Netlify Function.
create table if not exists public.slack_settings (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null unique references auth.users (id) on delete cascade,
  webhook_url          text,
  notify_clock_in      boolean not null default true,
  notify_clock_out     boolean not null default true,
  notify_break_start   boolean not null default true,
  notify_break_end     boolean not null default true,
  notify_payment_paid  boolean not null default true,
  task_webhook_url     text,
  notify_task_created  boolean not null default true,
  notify_task_moved    boolean not null default true,
  approval_webhook_url     text,
  notify_task_approval_created boolean not null default true,
  notify_task_approval_moved   boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

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

-- ============================================================
-- Clients (master list) + client tagging
-- The admin's list of customers. Only ACTIVE clients are offered when
-- assigning a task or clocking in; inactive ones keep labelling the work
-- that already happened. Workers may read the list, never change it.
-- See supabase/clients.sql for existing databases (same statements + a
-- backfill for work logged before clients existed).
-- ============================================================

create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  color      text not null default 'blue'
             check (color in ('blue','aqua','violet','emerald','amber','orange','rose','slate')),
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clients_user_idx on public.clients (user_id);
create index if not exists clients_user_status_idx on public.clients (user_id, status);
create unique index if not exists clients_user_name_key
  on public.clients (user_id, lower(btrim(name)));

-- Which client a task / entry / running timer belongs to.
alter table public.tasks
  add column if not exists client_id uuid references public.clients (id) on delete set null;
alter table public.time_entries
  add column if not exists client_id uuid references public.clients (id) on delete set null;
alter table public.active_timers
  add column if not exists client_id uuid references public.clients (id) on delete set null;

create index if not exists tasks_client_idx on public.tasks (client_id);
create index if not exists time_entries_client_idx on public.time_entries (client_id);

alter table public.clients enable row level security;

drop policy if exists "clients_select" on public.clients;
create policy "clients_select" on public.clients
  for select using (
    (select auth.uid()) = user_id
    or user_id = (select public.workspace_owner_id())
  );

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

drop trigger if exists trg_clients_user on public.clients;
create trigger trg_clients_user before insert on public.clients
  for each row execute function public.set_user_id();

drop trigger if exists trg_clients_updated on public.clients;
create trigger trg_clients_updated before update on public.clients
  for each row execute function public.set_updated_at();

-- ============================================================
-- Per-worker permissions
-- The admin can hand individual admin capabilities to individual workers
-- (view the team's time, run everyone's board, manage payments, …). A worker
-- with an empty `permissions` array is a plain worker: their own time and
-- their own board, exactly as before.
-- The policies below add one branch per capability to the rules above; the
-- app checks the same keys (Permission in src/lib/types.ts).
-- See supabase/worker-permissions.sql for existing databases.
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
    'priority_board.view',
    'meetings.view',
    'payments.view_all',
    'payments.manage',
    'finance.view',
    'finance.manage',
    'finance.subscription',
    'finance.payroll',
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
      or public.has_permission('finance.subscription')
      or public.has_permission('finance.payroll')
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
    -- The team-wide time read: granted outright (`entries.view_all`) or
    -- through Reports (`reports.view`) — a report is built out of everyone's
    -- entries, so reporting on the team needs the team's rows.
    or (user_id = (select public.workspace_owner_id())
        and ((select public.has_permission('entries.view_all'))
             or (select public.has_permission('reports.view'))))
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

-- clients ------------------------------------------------------------------
drop policy if exists "clients_insert_admin" on public.clients;
create policy "clients_insert_admin" on public.clients
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('clients.manage')))
  );

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

drop policy if exists "clients_delete_admin" on public.clients;
create policy "clients_delete_admin" on public.clients
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('clients.manage')))
  );

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

-- ============================================================
-- Finance (subscriptions, worker payroll, bill due dates)
-- One ledger table for the Finance section; a worker only reaches it when
-- the admin grants `finance.view` (read) / `finance.manage` (writes) —
-- admin-only by default. See supabase/finance.sql for existing databases.
-- ============================================================

create table if not exists public.finance_items (
  id           uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_finance_items_user.
  user_id      uuid not null references auth.users (id) on delete cascade,
  kind         text not null check (kind in ('subscription','payroll','bill')),
  -- Label for subscriptions and bills; payroll rows are named by their worker.
  name         text check (name is null or length(btrim(name)) between 1 and 80),
  -- The worker being paid (payroll only). Deleting the worker removes the run.
  worker_id    uuid references public.workers (id) on delete cascade,
  amount       numeric(12,2) not null default 0 check (amount >= 0),
  -- Billing cycle (subscriptions only).
  cycle        text check (cycle is null or cycle in ('monthly','yearly')),
  -- The month a payroll run covers, 'YYYY-MM' (payroll only).
  period_month text check (period_month is null or period_month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- Next bill date / pay day / deadline. A plain calendar date, like tasks.
  due_date     date not null,
  -- active/paused are subscription states; unpaid/paid the other two.
  status       text not null default 'active'
               check (status in ('active','paused','unpaid','paid')),
  -- When a payroll run or bill was marked paid (subscriptions never use it).
  paid_at      timestamptz,
  note         text,
  -- Subscriptions only: how many times the subscription bills before it
  -- pauses by itself (null = until someone switches it off), and how many
  -- of those bills have happened. See supabase/finance-subscription-occurrences.sql.
  max_occurrences integer check (max_occurrences is null or max_occurrences > 0),
  billed_count    integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Shape rules per kind, so rows written outside the app cannot go rogue.
  constraint finance_items_needs_name check (
    kind = 'payroll' or (name is not null and btrim(name) <> '')
  ),
  constraint finance_items_payroll_fields check (
    (kind = 'payroll' and worker_id is not null and period_month is not null)
    or (kind <> 'payroll' and worker_id is null)
  ),
  constraint finance_items_cycle_only_subs check (
    (kind = 'subscription' and cycle is not null) or (kind <> 'subscription' and cycle is null)
  ),
  constraint finance_items_status_per_kind check (
    (kind = 'subscription' and status in ('active','paused'))
    or (kind <> 'subscription' and status in ('unpaid','paid'))
  ),
  constraint finance_items_paid_stamp check (
    (status = 'paid' and paid_at is not null) or (status <> 'paid' and paid_at is null)
  )
);

create index if not exists finance_items_user_idx on public.finance_items (user_id);
-- The agenda query: one workspace's open lines, oldest due date first.
create index if not exists finance_items_user_due_idx on public.finance_items (user_id, due_date);
-- One payroll run per worker per month.
create unique index if not exists finance_items_payroll_unique
  on public.finance_items (user_id, worker_id, period_month)
  where kind = 'payroll';

alter table public.finance_items enable row level security;

-- The admin owns the ledger; a worker reads it with finance.view and changes
-- it with finance.manage. Both are off by default, so the section is
-- admin-only until the admin grants them.
drop policy if exists "finance_items_select" on public.finance_items;
-- Read: the admin, or a worker holding finance.view (the whole ledger) or one
-- of the granular view keys (the app shows them only their tab; the row-level
-- policy cannot split the ledger per tab, so granular viewers may read rows
-- their UI hides — the UI, not the database, is the tab gate).
create policy "finance_items_select" on public.finance_items
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id())
        and (select public.has_permission('finance.view')
             or public.has_permission('finance.subscription')
             or public.has_permission('finance.payroll')))
  );

drop policy if exists "finance_items_insert" on public.finance_items;
create policy "finance_items_insert" on public.finance_items
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('finance.manage')))
  );

drop policy if exists "finance_items_update" on public.finance_items;
create policy "finance_items_update" on public.finance_items
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('finance.manage')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('finance.manage')))
  );

drop policy if exists "finance_items_delete" on public.finance_items;
create policy "finance_items_delete" on public.finance_items
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('finance.manage')))
  );

drop trigger if exists trg_finance_items_user on public.finance_items;
create trigger trg_finance_items_user before insert on public.finance_items
  for each row execute function public.set_user_id();

drop trigger if exists trg_finance_items_updated on public.finance_items;
create trigger trg_finance_items_updated before update on public.finance_items
  for each row execute function public.set_updated_at();

-- ============================================================
-- Client priority board
-- One row per ranked client: which column ("lane") and its rank inside it.
-- Clients without a row are unranked (the app shows them at the bottom of
-- Low Priority), so "Reset board" deletes rows and nothing else. The admin
-- runs the board; a worker reaches it only with `priority_board.view`.
-- See supabase/client-priority-board.sql for existing databases.
-- ============================================================

create table if not exists public.client_priorities (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_client_priorities_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- The ranked client. Deleting the client removes its place on the board.
  client_id  uuid not null references public.clients (id) on delete cascade,
  -- Which column of the board the client sits in.
  lane       text not null default 'low' check (lane in ('me','delegated','waiting','low')),
  -- Manual ordering inside the column (smaller sorts first, 0 = top).
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per client per workspace.
create unique index if not exists client_priorities_user_client_key
  on public.client_priorities (user_id, client_id);
-- The board's exact query: one lane, in rank order.
create index if not exists client_priorities_user_lane_position_idx
  on public.client_priorities (user_id, lane, position);

alter table public.client_priorities enable row level security;

-- The admin and granted workers share one board (same pattern as finance).
drop policy if exists "client_priorities_select" on public.client_priorities;
create policy "client_priorities_select" on public.client_priorities
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_insert" on public.client_priorities;
create policy "client_priorities_insert" on public.client_priorities
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_update" on public.client_priorities;
create policy "client_priorities_update" on public.client_priorities
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_delete" on public.client_priorities;
create policy "client_priorities_delete" on public.client_priorities
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop trigger if exists trg_client_priorities_user on public.client_priorities;
create trigger trg_client_priorities_user before insert on public.client_priorities
  for each row execute function public.set_user_id();

drop trigger if exists trg_client_priorities_updated on public.client_priorities;
create trigger trg_client_priorities_updated before update on public.client_priorities
  for each row execute function public.set_updated_at();

-- ============================================================
-- Meetings
-- The workspace's meeting schedule (title, start, notes). The admin runs
-- the section; a worker reaches it only with `meetings.view`. There are no
-- attendees or invites — whoever can open the page sees the whole schedule.
-- See supabase/meetings.sql for existing databases.
-- ============================================================

create table if not exists public.meetings (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_meetings_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 200),
  -- Scheduled start.
  start_time timestamptz not null,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The agenda's exact query: one workspace, start order.
create index if not exists meetings_user_start_idx on public.meetings (user_id, start_time);

alter table public.meetings enable row level security;

-- The admin and granted workers share one schedule (same pattern as the
-- priority board).
drop policy if exists "meetings_select" on public.meetings;
create policy "meetings_select" on public.meetings
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_insert" on public.meetings;
create policy "meetings_insert" on public.meetings
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_update" on public.meetings;
create policy "meetings_update" on public.meetings
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_delete" on public.meetings;
create policy "meetings_delete" on public.meetings
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop trigger if exists trg_meetings_user on public.meetings;
create trigger trg_meetings_user before insert on public.meetings
  for each row execute function public.set_user_id();

drop trigger if exists trg_meetings_updated on public.meetings;
create trigger trg_meetings_updated before update on public.meetings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Personal Tracker (account menu → "Switch to Personal Tracker")
-- One strictly private document per authenticated account — the owner is the
-- auth user itself, not the workspace, so even the admin cannot read it.
-- (Same content as supabase/personal-finance.sql; fresh installs get it here.)
-- ============================================================================
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
