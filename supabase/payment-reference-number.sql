-- ============================================================
-- Work Tracker — Reference number on a paid settlement
-- ------------------------------------------------------------
-- Run this once on an existing Supabase database. When the admin
-- marks a payment as paid they now type the transfer's reference
-- number (GCash / Maya / bank ref) next to the payment method;
-- it is stored here and shown under “Paid via” in the payment
-- history — and on the worker's own payslips.
-- (Fresh installs get this automatically from schema.sql.)
--
-- Nothing breaks without it: the payment is still marked paid,
-- only the reference is dropped (the app says so when that
-- happens).
-- ============================================================

alter table public.payments
  add column if not exists reference_number text;

-- Refresh PostgREST's schema cache so the new column is usable right away.
notify pgrst, 'reload schema';
