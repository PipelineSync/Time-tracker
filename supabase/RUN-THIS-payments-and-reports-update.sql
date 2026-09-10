-- ============================================================================
--  WORK TRACKER — ONE COPY-PASTE UPDATE FOR AN EXISTING SUPABASE DATABASE
--
--  Supabase → SQL Editor → New query → paste all of this → Run
--
--  Bundles everything the last two app changes need, in the right order:
--
--    1. PAYMENT METHOD + REFERENCE NUMBER
--       payments.payment_method      — Cash / QR Code chosen at "Mark paid"
--       payments.reference_number    — GCash / Maya / bank ref typed there
--
--    2. WORKER PAYMENT METHODS (the columns + the self-service RPC)
--       workers.payment_methods / workers.qr_code_url — only added if the
--       database predates them; without them a worker cannot choose how to
--       be paid and the Mark paid dialog has nothing to offer.
--
--    3. REPORTS = THE WHOLE TEAM'S REPORT
--       widens time_entries_select so a worker granted Reports reads every
--       worker's entries (a report is computed from them), and adds
--       entries.view_all to any worker row that already had Reports ticked.
--
--  Safe to re-run: every statement is "add if missing" / drop-then-create /
--  guarded by a check, so running it twice changes nothing and loses no data.
--  A brand-new database created from supabase/schema.sql already has all of
--  this and does not need this file.
--
--  The verification queries at the bottom print what is in place.
-- ============================================================================


-- ############################################################################
-- #  1. How a settlement was paid (method + reference number)
-- ############################################################################

-- How the admin paid: 'cash' or 'qr'. Null until the payment is marked paid.
alter table public.payments
  add column if not exists payment_method text
  check (payment_method is null or payment_method in ('cash','qr'));

-- The transfer's reference (GCash / Maya / bank ref, receipt or voucher).
alter table public.payments
  add column if not exists reference_number text;


-- ############################################################################
-- #  2. Worker payment methods (Cash / QR Code) — columns + self-service RPC
-- ############################################################################

-- Which payment methods the worker accepts: 'cash' and/or 'qr'.
alter table public.workers
  add column if not exists payment_methods text[] not null default '{}';

-- The uploaded QR code image (data URL), required while 'qr' is enabled.
alter table public.workers
  add column if not exists qr_code_url text;

-- Keep the contents valid: only the two supported methods.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workers_payment_methods_check'
  ) then
    alter table public.workers
      add constraint workers_payment_methods_check
      check (payment_methods <@ array['cash','qr']::text[]);
  end if;
end
$$;

-- Workers cannot UPDATE their own `workers` row directly (that RLS policy is
-- admin-only so they cannot change their own rate or status). This SECURITY
-- DEFINER function lets the signed-in worker change ONLY the payment fields on
-- their own row.
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

  -- Keep only the supported methods, de-duplicated, in a fixed order.
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
    -- QR payments require the image: use the provided one, or keep whatever
    -- is already saved on the row when the caller didn't resend it.
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
    -- QR disabled — its image is no longer relevant.
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


-- ############################################################################
-- #  3. Reports access = a report of the whole team
-- ############################################################################

do $$
begin
  if to_regprocedure('public.has_permission(text)') is null then
    -- Per-worker access is not installed yet, so there is nothing to widen:
    -- run supabase/worker-permissions.sql (or
    -- supabase/RUN-THIS-clients-and-permissions.sql part 2) first.
    raise notice 'Skipped the time_entries policy: public.has_permission(text) does not exist yet — run supabase/worker-permissions.sql first.';
  else
    drop policy if exists "time_entries_select" on public.time_entries;
    create policy "time_entries_select" on public.time_entries
      for select using (
        (select auth.uid()) = user_id
        or worker_id = (select public.current_worker_id())
        -- The team-wide time read: granted outright (`entries.view_all`) or
        -- through Reports (`reports.view`) — a report is built out of
        -- everyone's entries, so reporting on the team needs the team's rows.
        or (user_id = (select public.workspace_owner_id())
            and ((select public.has_permission('entries.view_all'))
                 or (select public.has_permission('reports.view'))))
      );
    raise notice 'time_entries_select widened: reports.view now reads the whole team''s entries.';
  end if;
end
$$;

-- Reports now implies the team-wide time read: keep the stored grants in step
-- with what the app implies when the admin ticks Reports.
update public.workers
   set permissions = array_append(permissions, 'entries.view_all')
 where 'reports.view' = any(permissions)
   and not ('entries.view_all' = any(permissions));


-- Refresh PostgREST's schema cache so the new columns are usable right away.
notify pgrst, 'reload schema';


-- ############################################################################
-- #  VERIFY — expect one row per column below, and the policies listed
-- ############################################################################

-- payments.payment_method, payments.reference_number,
-- workers.payment_methods, workers.qr_code_url
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('payments', 'payment_method'),
    ('payments', 'reference_number'),
    ('workers', 'payment_methods'),
    ('workers', 'qr_code_url')
  )
order by table_name, column_name;

-- the worker self-service RPC
select proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'update_own_payment_methods';

-- the four time_entries policies
select policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'time_entries'
order by policyname;

-- workers holding Reports (they should all carry entries.view_all too)
select id, name, permissions
from public.workers
where 'reports.view' = any(permissions);
