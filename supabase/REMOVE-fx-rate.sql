-- ============================================================================
--  WORK TRACKER — REMOVE USD -> PHP EXCHANGE RATE FEATURE
--
--  Run this in Supabase SQL Editor if you previously ran RUN-THIS-fx-rate.sql
--  and now want to remove the exchange rate feature completely.
--
--  Safe to re-run: drops columns if they exist.
-- ============================================================================

alter table public.settings drop constraint if exists settings_usd_php_rate_sane;
alter table public.settings drop column if exists usd_php_rate;
alter table public.settings drop column if exists usd_php_rate_updated_at;

-- Verify removal
select column_name 
from information_schema.columns 
where table_schema='public' and table_name='settings' 
  and column_name in ('usd_php_rate','usd_php_rate_updated_at');
-- Should return 0 rows if removed successfully
