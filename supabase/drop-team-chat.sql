-- ============================================================
-- Work Tracker — Drop the removed team-chat backend objects
-- ------------------------------------------------------------
-- OPTIONAL cleanup. The Chat section was removed from the app, so
-- these tables and functions get zero traffic. Running this only
-- reclaims a little database space and removes dead objects — the
-- app works exactly the same whether you run it or not.
--
-- Run the whole file once in the Supabase SQL editor.
-- Safe to re-run (every statement is IF EXISTS).
--
-- What it drops:
--   * chat_reactions + chat_messages tables (policies, triggers
--     and indexes on them go away automatically via CASCADE)
--   * post_chat_message(), workspace_members(),
--     notify_chat_message(), list_chat_reactions(),
--     toggle_chat_reaction() functions
--
-- What it deliberately KEEPS:
--   * public.set_user_id() — shared trigger used by other tables
--   * public.workspace_owner_id() / is_admin() — still used by RLS
--   * the 'chat' value in notifications_type_check + any old
--     'chat' notification rows (harmless history; uncomment the
--     DELETE below if you want them gone too)
-- ============================================================

drop function if exists public.toggle_chat_reaction(uuid, text);
drop function if exists public.list_chat_reactions();
drop function if exists public.notify_chat_message(uuid);
drop function if exists public.workspace_members();
drop function if exists public.post_chat_message(text);

drop table if exists public.chat_reactions cascade;
drop table if exists public.chat_messages cascade;

-- Optional: also delete old team-chat notifications from the bell history.
-- delete from public.notifications where type = 'chat';
