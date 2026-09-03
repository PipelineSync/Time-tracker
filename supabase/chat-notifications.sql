-- ============================================================
-- Work Tracker — Notifications for team-chat messages
-- ------------------------------------------------------------
-- Run this once in the Supabase SQL editor, after
-- supabase/chat-messages.sql (it uses public.workspace_members()).
-- Fresh installs already get everything below from schema.sql.
--
-- What it adds:
--   * 'chat' as a valid notifications.type.
--   * notify_chat_message(chat_id) — SECURITY DEFINER. Writes one
--     notification row per member of the caller's workspace except
--     the author, so a message in the Chat section notifies everyone
--     else (bell badge + the badge on the Chat item in the sidebar).
--     A worker cannot do this directly: under RLS a worker may only
--     insert notifications for themselves and the workspace admin.
-- ============================================================

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('note','time_in','time_out','time_added','payment','break_start','break_end','chat'));

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

  -- Same wording as the client's chatNotificationText(): "Name: preview".
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
