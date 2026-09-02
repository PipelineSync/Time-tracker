-- ============================================================
-- Work Tracker — Worker self-service payment methods
-- ------------------------------------------------------------
-- Run this once on an existing Supabase database to let workers
-- choose how they can be paid (Cash and/or QR Code) from their
-- Settings page, uploading their QR code image when QR Code is
-- enabled. The admin sees the enabled methods and the QR image
-- on the Payments page.
-- (Fresh installs get this automatically from schema.sql.)
--
-- Workers cannot UPDATE their own `workers` row directly (the
-- RLS update policy is admin-only so they cannot tamper with
-- their hourly rate / status). This SECURITY DEFINER RPC lets
-- the signed-in worker change ONLY the payment fields on their
-- own row.
-- ============================================================

-- Which payment methods the worker accepts: 'cash' and/or 'qr'.
alter table public.workers add column if not exists payment_methods text[] not null default '{}';
-- The uploaded QR code image (data URL), required while 'qr' is enabled.
alter table public.workers add column if not exists qr_code_url text;

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
end $$;

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
