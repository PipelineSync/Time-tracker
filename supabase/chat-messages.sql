-- ============================================================
-- Work Tracker — Team chat (Chat section for admin + workers)
-- ------------------------------------------------------------
-- Run this once in the Supabase SQL editor to add the workspace
-- team chat used by the Chat page in the sidebar. Fresh installs
-- get everything below from schema.sql.
--
-- What it creates:
--   * chat_messages — one shared room per workspace (no channels).
--     Rows are owned by the workspace admin's user_id, like every
--     other admin-owned table, and carry a snapshot of the author's
--     name / role / profile picture so a message is always readable.
--   * RLS so the admin and every worker of that workspace can read
--     the same messages, and only the admin may remove them.
--   * post_chat_message(body) — SECURITY DEFINER, stamps the author
--     from auth.uid() so nobody can post as somebody else.
--   * workspace_members() — SECURITY DEFINER, so a worker can list
--     the whole team ("See all members"), including the admin, even
--     though RLS limits their reads of the workers/profiles tables.
-- ============================================================

create table if not exists public.chat_messages (
  id                uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set by trg_chat_messages_user / the RPC.
  user_id           uuid not null references auth.users (id) on delete cascade,
  author_id         uuid not null references auth.users (id) on delete cascade,
  -- Worker row for workers; null for a message from the admin.
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

-- ---------- Row Level Security ----------
alter table public.chat_messages enable row level security;

-- One shared room: the admin and every worker of the workspace read the same
-- messages (rows are owned by the workspace admin's user_id).
drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select using (user_id = public.workspace_owner_id());

-- Posts go through post_chat_message(), which runs as the function owner. The
-- direct insert path is reserved for the admin (used by the sample-data
-- loader) and still pins author_id to the caller.
drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert" on public.chat_messages
  for insert with check (public.is_admin() and auth.uid() = user_id and auth.uid() = author_id);

-- The admin can clear the room (also used by "Delete all data").
drop policy if exists "chat_messages_delete" on public.chat_messages;
create policy "chat_messages_delete" on public.chat_messages
  for delete using (public.is_admin() and auth.uid() = user_id);

-- Auto-assign user_id for rows inserted without the RPC (defense in depth).
drop trigger if exists trg_chat_messages_user on public.chat_messages;
create trigger trg_chat_messages_user before insert on public.chat_messages
  for each row execute function public.set_user_id();

-- ---------- Post a message ----------
-- Author identity (name / role / position / profile picture) is resolved from
-- the caller, never from the request, so a worker cannot impersonate the admin
-- or another teammate.
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

-- ---------- Member list ----------
-- The Chat page's "See all members" list. Workers may not read other members'
-- rows under RLS, so this SECURITY DEFINER function returns the roster for the
-- caller's own workspace only — the admin first, then everyone else A→Z.
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
