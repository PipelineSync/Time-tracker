-- ============================================================
-- Work Tracker — custom client colours
--
-- Run this in the Supabase SQL editor on a database that already has
-- clients (from supabase/clients.sql or supabase/schema.sql) to let a
-- client carry ANY colour, not just one of the eight built-in tags:
-- the Clients dialog gained a custom swatch (the browser's own colour
-- picker), and clients.color is loosened to accept a #RGB/#RRGGBB hex
-- alongside the eight tag names. New databases already get the
-- loosened check from supabase/schema.sql. Safe to re-run.
-- ============================================================

-- The original constraint is named clients_color_check (Postgres auto-names
-- check constraints <table>_<column>_check); drop it before adding the
-- loosened version so this file is re-runnable.
alter table public.clients drop constraint if exists clients_color_check;
alter table public.clients add constraint clients_color_check
  check (color in ('blue','aqua','violet','emerald','amber','orange','rose','slate')
         or color ~* '^#([0-9a-f]{3}|[0-9a-f]{6})$');

-- Quick check: list any existing clients (rows created before this change
-- all carry one of the eight tag names, so nothing needs touching).
select name, color, status from public.clients order by name;
