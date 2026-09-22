-- ============================================================
-- Work Tracker — Team KPI (task stages, workload schedule, goals)
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Team KPI section. New databases get the same statements from
-- supabase/schema.sql. Safe to re-run.
--
-- What it does
--   1. adds 'team_kpi.view' to the allowed permission keys (the Project
--      Manager's grant — the Owner/admin implies it) and teaches
--      has_team_view() + the tasks read policy about it, so a PM can see the
--      team rows the dashboard aggregates
--   2. adds the per-worker SCHEDULE columns (workdays + weekly capacity) —
--      the workload maths compare open estimated hours to each person's real
--      workweek (e.g. Jasper & Mary Mon–Fri; Matthew, Jea, April Tue–Sat)
--   3. standardises task STAGES to the six the board uses:
--      todo → in_progress → waiting → for_review → rework → completed
--      ('approval' is renamed to 'for_review'; 'rework' is new), adds the
--      KPI fields (due-date history, stage timestamps, estimates, QA score,
--      rework classification, stage history) and back-fills existing rows
--   4. creates monthly_goals — the only management numbers people type
--      (planned tasks, on-time %, QA % per person/month)
--   5. creates bonus_decisions — manual, Owner-only bonus records
--   6. creates kpi_audit_events — append-only trail of QA scores, rework
--      classes, due-date changes, completions and bonus approvals
--
-- Everything else (scores, on-time %, workload %, attention rules) is
-- COMPUTED from tasks — there is deliberately no table to double-enter it.
--
-- Prerequisite: supabase/worker-permissions.sql (has_permission,
-- workspace_owner_id, is_admin, set_user_id/set_updated_at triggers).
-- ============================================================

-- ---------- 1. the permission key ----------
-- Widen the allow-list so a worker row may carry the new capability. Existing
-- workers keep an empty permissions array, so nothing changes for anyone
-- until the admin ticks the box in Workers → Edit → Access (or the Project
-- Manager is granted "View Team KPI").
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
    'invoices.view',
    'payments.view_all',
    'payments.manage',
    'finance.view',
    'finance.manage',
    'finance.subscription',
    'finance.payroll',
    'reports.view',
    'clients.manage',
    'settings.manage',
    -- The support desk (worker-only capability — see ticket-support.sql).
    'it_support.manage',
    -- Team KPI dashboard: Owner implies it; this is the PM's grant.
    'team_kpi.view'
  ]::text[]
);

-- A PM holding ONLY team_kpi.view still needs worker names (the table's
-- Employee column) — has_team_view() gates the workers read policy.
create or replace function public.has_team_view()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission('workers.view')
      or public.has_permission('dashboard.view')
      or public.has_permission('entries.view_all')
      or public.has_permission('tasks.view_all')
      or public.has_permission('payments.view_all')
      or public.has_permission('finance.view')
      or public.has_permission('finance.subscription')
      or public.has_permission('finance.payroll')
      or public.has_permission('reports.view')
      or public.has_permission('team_kpi.view');
$$;

grant execute on function public.has_team_view() to authenticated;

-- …and the tasks read policy, so the dashboard (and its drill-downs) can
-- aggregate the whole team's tasks. Re-declared exactly as in
-- worker-permissions.sql, with one more branch.
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('tasks.view_all')))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

-- ---------- 2. per-worker schedule (workload, §5) ----------
-- Day indexes: 0=Sun … 6=Sat (Postgres DAY indexes, same as the app).
alter table public.workers add column if not exists workdays smallint[]
  not null default '{1,2,3,4,5}';
alter table public.workers add column if not exists weekly_capacity_hours numeric
  not null default 40;
alter table public.workers drop constraint if exists workers_schedule_valid;
alter table public.workers add constraint workers_schedule_valid check (
  coalesce(array_length(workdays, 1), 0) between 1 and 7
  and workdays <@ array[0,1,2,3,4,5,6]::smallint[]
  and weekly_capacity_hours > 0
  and weekly_capacity_hours <= 168
);

-- ---------- 3. task stages + KPI columns ----------
-- Stage timestamps (auto-filled by the app, back-filled to neutral values for
-- existing rows — the client normalises anything it reads anyway).
alter table public.tasks add column if not exists original_due_date date;
alter table public.tasks add column if not exists estimated_hours numeric;
alter table public.tasks add column if not exists assigned_at timestamptz;
alter table public.tasks add column if not exists started_at timestamptz;
alter table public.tasks add column if not exists waiting_since timestamptz;
alter table public.tasks add column if not exists submitted_for_review_at timestamptz;
alter table public.tasks add column if not exists rework_started_at timestamptz;
alter table public.tasks add column if not exists waiting_reason text;
alter table public.tasks add column if not exists qa_score smallint;
alter table public.tasks add column if not exists qa_reviewed_at timestamptz;
alter table public.tasks add column if not exists qa_reviewed_by text;
alter table public.tasks add column if not exists rework_required boolean;
alter table public.tasks add column if not exists rework_type text;
alter table public.tasks add column if not exists rework_notes text;
alter table public.tasks add column if not exists stage_history jsonb not null default '[]'::jsonb;

alter table public.tasks drop constraint if exists tasks_estimated_hours_valid;
alter table public.tasks add constraint tasks_estimated_hours_valid
  check (estimated_hours is null or estimated_hours >= 0);

alter table public.tasks drop constraint if exists tasks_waiting_reason_valid;
alter table public.tasks add constraint tasks_waiting_reason_valid
  check (waiting_reason is null or waiting_reason in (
    'client', 'manager', 'teammate', 'access', 'approval', 'external', 'other'
  ));

alter table public.tasks drop constraint if exists tasks_qa_score_valid;
alter table public.tasks add constraint tasks_qa_score_valid
  check (qa_score is null or qa_score between 1 and 5);

alter table public.tasks drop constraint if exists tasks_rework_type_valid;
alter table public.tasks add constraint tasks_rework_type_valid
  check (rework_type is null or rework_type in (
    'incorrect_work',
    'missing_requirement',
    'incomplete_work',
    'did_not_follow_instructions',
    'qa_correction',
    'client_requested_change',
    'scope_changed',
    'new_requirement',
    'missing_client_info',
    'access_issue'
  ));

-- 3a. the six-stage vocabulary: rename 'approval' → 'for_review' FIRST (the
-- new CHECK below would otherwise reject the old rows).
update public.tasks
   set status = 'for_review'
 where status = 'approval';

-- 3b. back-fill the new KPI columns so old rows read cleanly (client-side
-- hydrateTask() fills anything still null, but this keeps SQL honest too).
update public.tasks
   set assigned_at = coalesce(assigned_at, created_at)
 where assigned_at is null;
update public.tasks
   set started_at = coalesce(started_at, created_at)
 where status in ('in_progress','waiting','for_review','rework','completed')
   and started_at is null;
update public.tasks
   set waiting_since = coalesce(waiting_since, updated_at)
 where status = 'waiting' and waiting_since is null;
update public.tasks
   set submitted_for_review_at = coalesce(submitted_for_review_at, updated_at)
 where status = 'for_review' and submitted_for_review_at is null;
update public.tasks
   set rework_started_at = coalesce(rework_started_at, updated_at)
 where status = 'rework' and rework_started_at is null;
update public.tasks
   set stage_history = '[]'::jsonb
 where stage_history is null;

-- 3c. the stage CHECK: all six values (the old five-value constraint used the
-- same auto-name, so dropping it covers both tasks.sql layouts).
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (
  status in ('todo', 'in_progress', 'waiting', 'for_review', 'rework', 'completed')
);

-- ---------- 4. monthly goals ----------
create table if not exists public.monthly_goals (
  id            uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_monthly_goals_user.
  user_id       uuid not null references auth.users (id) on delete cascade,
  worker_id     uuid not null references public.workers (id) on delete cascade,
  -- The month the targets cover, 'YYYY-MM'.
  month         text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- Planned completions for the month (role-specific task count).
  target        integer check (target is null or target >= 0),
  -- Role-specific on-time % target (Mary: 95; default: 90).
  on_time_target numeric(5,2) check (on_time_target is null or (on_time_target >= 0 and on_time_target <= 100)),
  -- QA % target (default 90).
  qa_target     numeric(5,2) check (qa_target is null or (qa_target >= 0 and qa_target <= 100)),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One row per worker per month — editing targets is an upsert, never a
  -- second row (duplicates would double the goal in the KPI maths).
  unique (user_id, worker_id, month)
);

create index if not exists monthly_goals_user_month_idx
  on public.monthly_goals (user_id, month);

alter table public.monthly_goals enable row level security;

drop policy if exists "monthly_goals_select" on public.monthly_goals;
create policy "monthly_goals_select" on public.monthly_goals
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop policy if exists "monthly_goals_insert" on public.monthly_goals;
create policy "monthly_goals_insert" on public.monthly_goals
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop policy if exists "monthly_goals_update" on public.monthly_goals;
create policy "monthly_goals_update" on public.monthly_goals
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop policy if exists "monthly_goals_delete" on public.monthly_goals;
create policy "monthly_goals_delete" on public.monthly_goals
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop trigger if exists trg_monthly_goals_user on public.monthly_goals;
create trigger trg_monthly_goals_user before insert on public.monthly_goals
  for each row execute function public.set_user_id();

drop trigger if exists trg_monthly_goals_updated on public.monthly_goals;
create trigger trg_monthly_goals_updated before update on public.monthly_goals
  for each row execute function public.set_updated_at();

-- ---------- 5. bonus decisions (Owner-only writes) ----------
create table if not exists public.bonus_decisions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  worker_id       uuid not null references public.workers (id) on delete cascade,
  month           text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  -- Yes / No / Pending — always a human decision, never derived from the KPI.
  eligible        text not null default 'pending' check (eligible in ('pending','yes','no')),
  -- The amount the Owner approved (null until decided).
  approved_amount numeric(12,2) check (approved_amount is null or approved_amount >= 0),
  approved_by     text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, worker_id, month)
);

create index if not exists bonus_decisions_user_month_idx
  on public.bonus_decisions (user_id, month);

alter table public.bonus_decisions enable row level security;

-- Reads follow the KPI grant; WRITES are is_admin() only — a Project Manager
-- may view the dashboard but never touch money (§12).
drop policy if exists "bonus_decisions_select" on public.bonus_decisions;
create policy "bonus_decisions_select" on public.bonus_decisions
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop policy if exists "bonus_decisions_insert" on public.bonus_decisions;
create policy "bonus_decisions_insert" on public.bonus_decisions
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "bonus_decisions_update" on public.bonus_decisions;
create policy "bonus_decisions_update" on public.bonus_decisions
  for update using ((select auth.uid()) = user_id and (select public.is_admin()))
  with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "bonus_decisions_delete" on public.bonus_decisions;
create policy "bonus_decisions_delete" on public.bonus_decisions
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));

drop trigger if exists trg_bonus_decisions_user on public.bonus_decisions;
create trigger trg_bonus_decisions_user before insert on public.bonus_decisions
  for each row execute function public.set_user_id();

drop trigger if exists trg_bonus_decisions_updated on public.bonus_decisions;
create trigger trg_bonus_decisions_updated before update on public.bonus_decisions
  for each row execute function public.set_updated_at();

-- ---------- 6. KPI audit trail ----------
create table if not exists public.kpi_audit_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  -- What the line is about: a task action, a goal edit, a bonus approval…
  entity_type text not null check (entity_type in ('task','goal','bonus','worker')),
  entity_id   text not null,
  -- The employee the event counts for (null for goal/bonus rows that name
  -- their worker directly, kept for uniform filtering in the UI).
  worker_id   uuid references public.workers (id) on delete set null,
  -- e.g. qa_scored, rework_classified, due_date_changed, completed,
  -- bonus_decided, goal_saved.
  action      text not null,
  detail      text,
  -- Display name of whoever did it ("Owner", the PM's name, the worker…).
  actor       text,
  created_at  timestamptz not null default now()
);

create index if not exists kpi_audit_events_user_created_idx
  on public.kpi_audit_events (user_id, created_at desc);
create index if not exists kpi_audit_events_worker_idx
  on public.kpi_audit_events (worker_id);

alter table public.kpi_audit_events enable row level security;

-- Readable by the KPI grant; written by the backend as part of the actions
-- that produce the events (RLS: workspace-scoped inserts by the same readers).
drop policy if exists "kpi_audit_events_select" on public.kpi_audit_events;
create policy "kpi_audit_events_select" on public.kpi_audit_events
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop policy if exists "kpi_audit_events_insert" on public.kpi_audit_events;
create policy "kpi_audit_events_insert" on public.kpi_audit_events
  for insert with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or (user_id = (select public.workspace_owner_id()) and (select public.has_permission('team_kpi.view')))
  );

drop policy if exists "kpi_audit_events_update" on public.kpi_audit_events;
create policy "kpi_audit_events_update" on public.kpi_audit_events
  for update using ((select auth.uid()) = user_id and (select public.is_admin()))
  with check ((select auth.uid()) = user_id and (select public.is_admin()));

drop policy if exists "kpi_audit_events_delete" on public.kpi_audit_events;
create policy "kpi_audit_events_delete" on public.kpi_audit_events
  for delete using ((select auth.uid()) = user_id and (select public.is_admin()));

drop trigger if exists trg_kpi_audit_events_user on public.kpi_audit_events;
create trigger trg_kpi_audit_events_user before insert on public.kpi_audit_events
  for each row execute function public.set_user_id();

-- ---------- verify ----------
-- Expect: the schedule columns, zero legacy 'approval' rows, six allowed
-- stages, and the three new tables.
select column_name
  from information_schema.columns
 where table_schema = 'public' and table_name = 'workers'
   and column_name in ('workdays', 'weekly_capacity_hours');
select count(*) as legacy_approval_rows
  from public.tasks where status = 'approval';
select conname
  from pg_constraint
 where conname = 'tasks_status_check';
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name in ('monthly_goals', 'bonus_decisions', 'kpi_audit_events');
select public.has_permission('team_kpi.view') as admin_can_use_team_kpi;
