-- ============================================================
-- Work Tracker — Worker self-service profile picture
-- ------------------------------------------------------------
-- Run this once on an existing Supabase database to let workers
-- upload their own profile picture from their Settings page.
-- (Fresh installs get this automatically from schema.sql.)
--
-- Workers cannot UPDATE their own `workers` row directly (the
-- RLS update policy is admin-only so they cannot tamper with
-- their hourly rate / status). This SECURITY DEFINER RPC lets the
-- signed-in worker change ONLY the avatar on their own row.
-- ============================================================

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
