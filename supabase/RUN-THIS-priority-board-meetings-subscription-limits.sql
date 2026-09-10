-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  It adds everything from the latest app update, in the right order:
--
--    1. PERMISSION KEYS      widens the workers permission allow-list with
--                            priority_board.view and meetings.view, so the
--                            admin can tick the two new Access boxes
--    2. CLIENT PRIORITY BOARD   the client_priorities table (which column +
--                            rank each ranked client sits in) + RLS
--    3. MEETINGS             the meetings schedule table + RLS
--    4. SUBSCRIPTION LIMITS  max_occurrences + billed_count on finance_items
--                            ("for a set number of bills, then it pauses
--                            itself")
--
--  Safe to re-run: every statement is idempotent (create ... if not exists /
--  drop-then-create), so running it twice changes nothing and loses no data.
--
--  Prerequisite: the per-worker access migration (supabase/worker-permissions.sql)
--  must already be applied — the policies below use its has_permission()
--  helper. If the Access tick boxes on the Workers page work today, you are
--  good. It also expects the Clients table (supabase/clients.sql), which any
--  workspace using clients already has.
--
--  The verification queries at the very bottom print what was created.
-- ============================================================================


-- ############################################################################
-- #  PART 1 of 4 — PERMISSION KEYS
-- ############################################################################

-- Widen the allow-list so a worker row may carry the two new capabilities.
-- Existing workers keep an empty permissions array, so nothing changes for
-- anyone until the admin ticks a box in Workers → Edit → Access.
alter table public.workers drop constraint if exists workers_permissions_valid;
alter table public.workers add constraint workers_permissions_valid check (
  permissions <@ array[
    'dashboard.view',
    'workers.view',
    'workers.manage',
    'entries.view_all',
    'entries.manage',
    'tasks.view_all',
    'tasks.manage_all',
    'priority_board.view',
    'meetings.view',
    'payments.view_all',
    'payments.manage',
    'finance.view',
    'finance.manage',
    'finance.subscription',
    'finance.payroll',
    'reports.view',
    'clients.manage',
    'settings.manage'
  ]::text[]
);


-- ############################################################################
-- #  PART 2 of 4 — CLIENT PRIORITY BOARD
-- ############################################################################

-- One row per ranked client: which column ("lane") and its rank inside it.
-- Clients WITHOUT a row are unranked: the app shows them at the bottom of
-- Low Priority, so new clients land on the board by themselves and "Reset
-- board" simply deletes every row.
create table if not exists public.client_priorities (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_client_priorities_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- The ranked client. Deleting the client removes its place on the board.
  client_id  uuid not null references public.clients (id) on delete cascade,
  -- Which column of the board the client sits in.
  lane       text not null default 'low' check (lane in ('me','delegated','waiting','low')),
  -- Manual ordering inside the column (smaller sorts first, 0 = top).
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_priorities_user_idx on public.client_priorities (user_id);
-- One row per client per workspace — moving a card updates its row, it never duplicates.
create unique index if not exists client_priorities_user_client_key
  on public.client_priorities (user_id, client_id);
-- The board's exact query: one lane, in rank order.
create index if not exists client_priorities_user_lane_position_idx
  on public.client_priorities (user_id, lane, position);

alter table public.client_priorities enable row level security;

-- The admin and granted workers share one board.
drop policy if exists "client_priorities_select" on public.client_priorities;
create policy "client_priorities_select" on public.client_priorities
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_insert" on public.client_priorities;
create policy "client_priorities_insert" on public.client_priorities
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_update" on public.client_priorities;
create policy "client_priorities_update" on public.client_priorities
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

drop policy if exists "client_priorities_delete" on public.client_priorities;
create policy "client_priorities_delete" on public.client_priorities
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('priority_board.view')))
  );

-- Own the row by the workspace admin, even when a granted worker drags the
-- card; keep updated_at fresh.
drop trigger if exists trg_client_priorities_user on public.client_priorities;
create trigger trg_client_priorities_user before insert on public.client_priorities
  for each row execute function public.set_user_id();

drop trigger if exists trg_client_priorities_updated on public.client_priorities;
create trigger trg_client_priorities_updated before update on public.client_priorities
  for each row execute function public.set_updated_at();


-- ############################################################################
-- #  PART 3 of 4 — MEETINGS
-- ############################################################################

-- The workspace's meeting schedule (title, start, notes). No attendees or
-- invites — whoever can open the page sees the whole schedule.
create table if not exists public.meetings (
  id         uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_meetings_user.
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 200),
  -- Scheduled start.
  start_time timestamptz not null,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meetings_user_idx on public.meetings (user_id);
-- The agenda's exact query: one workspace, start order.
create index if not exists meetings_user_start_idx on public.meetings (user_id, start_time);

alter table public.meetings enable row level security;

-- The admin and granted workers share one schedule.
drop policy if exists "meetings_select" on public.meetings;
create policy "meetings_select" on public.meetings
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_insert" on public.meetings;
create policy "meetings_insert" on public.meetings
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_update" on public.meetings;
create policy "meetings_update" on public.meetings
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop policy if exists "meetings_delete" on public.meetings;
create policy "meetings_delete" on public.meetings
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('meetings.view')))
  );

drop trigger if exists trg_meetings_user on public.meetings;
create trigger trg_meetings_user before insert on public.meetings
  for each row execute function public.set_user_id();

drop trigger if exists trg_meetings_updated on public.meetings;
create trigger trg_meetings_updated before update on public.meetings
  for each row execute function public.set_updated_at();


-- ############################################################################
-- #  PART 4 of 4 — SUBSCRIPTION OCCURRENCE LIMITS (Finance)
-- ############################################################################

-- How many times a subscription bills before it pauses by itself
-- (null = runs until someone switches it off), and how many of those bills
-- have happened. The app counts one each time the next due date is rolled
-- forward ("Billed"), and reaching the limit pauses the subscription.
alter table public.finance_items
  add column if not exists max_occurrences integer check (max_occurrences is null or max_occurrences > 0);

alter table public.finance_items
  add column if not exists billed_count integer not null default 0;


-- ############################################################################
-- #  VERIFY — expect: t / t / the two new tables / the two new columns
-- ############################################################################

select public.has_permission('priority_board.view') as admin_can_use_priority_board;
select public.has_permission('meetings.view')       as admin_can_use_meetings;

select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'client_priorities') or (table_name = 'meetings'))
 order by table_name, ordinal_position;

select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'finance_items'
   and column_name in ('max_occurrences', 'billed_count')
 order by column_name;
