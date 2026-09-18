-- Store the payment method used for worker payroll runs.
alter table public.finance_items
  add column if not exists payment_method text
  check (payment_method is null or payment_method in ('cash', 'qr'));

notify pgrst, 'reload schema';
