-- ============================================================
-- Fix: "deleted workers can still log in"
--
-- Run this ONCE in the Supabase SQL editor (or via psql) for a
-- database created before the delete-worker fix. Fresh installs
-- don't need it — the fix is already part of supabase/schema.sql
-- and the app.
--
-- Background: deleting a worker used to remove only the workers
-- row. The worker's Supabase Auth account (their login) survived,
-- so they could keep signing in. Going forward, the app's
-- "delete-worker" Netlify function deletes the auth account too,
-- which permanently disables the login and invalidates the
-- worker's open sessions.
-- ============================================================

-- 1) Allow the admin to delete other accounts' profile rows. The original
--    schema had no profiles delete policy, so the app's profile cleanup was
--    silently blocked by RLS. (An admin can never delete their own profile.)
drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using (public.is_admin() and auth.uid() <> user_id);

-- 2) Preview the leftover logins that step 3 will remove (optional, but run
--    it first to see what will be deleted):
--
-- select p.user_id, au.email
-- from public.profiles p
-- join auth.users au on au.id = p.user_id
-- where p.role = 'worker'
--   and not exists (select 1 from public.workers w where w.id = p.worker_id)
--   and not exists (
--         select 1 from public.workers w
--         where w.email is not null and lower(w.email) = lower(au.email)
--       );

-- 3) Permanently remove the orphaned logins of workers that were deleted
--    before this fix. Their worker rows are already gone; this deletes the
--    leftover auth accounts (and cascades their profile rows) so they can
--    no longer sign in.
--
-- Accounts that still have a worker row — or whose email matches an existing
-- worker row (the app can re-link those automatically) — are left untouched.
--
-- WARNING: this is irreversible. The affected workers will need their admin
-- to re-create their login if they should have kept it.
delete from auth.users au
where exists (
  select 1 from public.profiles p
  where p.user_id = au.id
    and p.role = 'worker'
    and not exists (select 1 from public.workers w where w.id = p.worker_id)
    and not exists (
          select 1 from public.workers w
          where w.email is not null and lower(w.email) = lower(au.email)
        )
);

-- 4) Verify: no worker profile should point at a missing worker row, and no
--    orphaned worker login should remain.
select p.user_id, au.email, p.worker_id
from public.profiles p
join auth.users au on au.id = p.user_id
where p.role = 'worker'
  and not exists (select 1 from public.workers w where w.id = p.worker_id)
  and not exists (
        select 1 from public.workers w
        where w.email is not null and lower(w.email) = lower(au.email)
      );
