-- ============================================================
-- Work Tracker — Emoji reactions on team-chat messages
-- ------------------------------------------------------------
-- Run this once in the Supabase SQL editor, after
-- supabase/chat-messages.sql (reactions point at chat messages).
-- Fresh installs already get everything below from schema.sql.
--
-- What it creates:
--   * chat_reactions — one row per (message, member, emoji), so the same
--     person can react with several emoji but never twice with the same one.
--   * RLS so the admin and every worker of a workspace see the same
--     reactions, and no client can write a row directly.
--   * list_chat_reactions() / toggle_chat_reaction(message_id, emoji) —
--     SECURITY DEFINER, stamped from auth.uid(), so nobody can react as
--     somebody else or react to another workspace's message. Toggle means the
--     client sends the same emoji again to take a reaction back.
--
-- Reactions are deliberately quiet: they never create a notification. A
-- "thanks 👍" should not buzz a phone.
-- ============================================================

create table if not exists public.chat_reactions (
  id          uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin), like chat_messages. Set by trg_chat_reactions_user.
  user_id     uuid not null references auth.users (id) on delete cascade,
  message_id  uuid not null references public.chat_messages (id) on delete cascade,
  -- The member who reacted, and their name at the time (so a hover label
  -- survives a later profile change or account removal).
  author_id   uuid not null references auth.users (id) on delete cascade,
  author_name text not null,
  emoji       text not null check (char_length(emoji) between 1 and 8),
  created_at  timestamptz not null default now(),
  -- One emoji per member per message: tapping it again removes it.
  unique (message_id, author_id, emoji)
);

create index if not exists chat_reactions_message_idx on public.chat_reactions (message_id);
create index if not exists chat_reactions_user_created_idx on public.chat_reactions (user_id, created_at);

-- ---------- Row Level Security ----------
alter table public.chat_reactions enable row level security;

-- One shared room: everyone in the workspace reads the same reactions.
drop policy if exists "chat_reactions_select" on public.chat_reactions;
create policy "chat_reactions_select" on public.chat_reactions
  for select using (user_id = public.workspace_owner_id());

-- Adding and removing goes through toggle_chat_reaction(), which runs as the
-- function owner, so there is no insert or delete policy for clients. The admin
-- can still clear the room (also used by "Delete all data").
drop policy if exists "chat_reactions_delete" on public.chat_reactions;
create policy "chat_reactions_delete" on public.chat_reactions
  for delete using (public.is_admin() and auth.uid() = user_id);

-- Auto-assign user_id for rows inserted without the RPC (defense in depth).
drop trigger if exists trg_chat_reactions_user on public.chat_reactions;
create trigger trg_chat_reactions_user before insert on public.chat_reactions
  for each row execute function public.set_user_id();

-- ---------- Read the room's reactions ----------
-- The whole workspace's reactions, oldest first. The page is small (the chat
-- window itself is capped), so the client groups them by message.
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

-- ---------- Add or take back a reaction ----------
-- Returns the message's reactions afterwards, so the caller can drop the result
-- straight into the row it tapped without a second round trip.
create or replace function public.toggle_chat_reaction(message_id uuid, reaction_emoji text)
returns setof public.chat_reactions
language plpgsql
security definer
set search_path = public
as $$
declare
  me         uuid := auth.uid();
  owner_id   uuid;
  caller_role text;
  wid        uuid;
  v_name     text;
  v_emoji    text := btrim(coalesce(reaction_emoji, ''));
  -- Local copies: inside plpgsql a bare message_id would also match the column.
  v_message  uuid := toggle_chat_reaction.message_id;
  target     public.chat_messages;
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

  -- Who is reacting, resolved from the caller and never from the request.
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
    -- Not reacted yet (unique (message, member, emoji) keeps it to one row).
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
