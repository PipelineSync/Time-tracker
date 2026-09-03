-- ============================================================
-- Work Tracker — Record how a settlement was paid
-- ------------------------------------------------------------
-- Run this once on an existing Supabase database. When the admin
-- marks a payment as paid, the app shows the payment methods the
-- worker accepts (Cash / QR Code) and the admin picks the one
-- they used. That choice is stored here so the payment history
-- shows how each worker was paid.
-- (Fresh installs get this automatically from schema.sql.)
-- ============================================================

alter table public.payments
  add column if not exists payment_method text
  check (payment_method is null or payment_method in ('cash','qr'));

-- Refresh PostgREST's schema cache so the new column is usable right away.
notify pgrst, 'reload schema';
