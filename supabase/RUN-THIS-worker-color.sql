-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--   1. Adds the `color` column to public.workers so every worker can have
--      an optional colour tag (same 8 built-in tags + custom hex as clients).
--   2. Adds workers_color_check allowing the 8 built-in tags or a hex code
--      (null allowed) — mirroring clients_color_check.
--
--  Safe to re-run.
-- ============================================================================

alter table public.workers add column if not exists color text;

alter table public.workers drop constraint if exists workers_color_check;
alter table public.workers add constraint workers_color_check
  check (
    color is null
    or color in ('blue', 'aqua', 'violet', 'emerald', 'amber', 'orange', 'rose', 'slate')
    or color ~* '^#[0-9a-fA-F]{6}$'
    or color ~* '^#[0-9a-fA-F]{3}$'
  );

-- Verify: show any existing workers with their colour tag
select id, name, color, status from public.workers order by name limit 10;
