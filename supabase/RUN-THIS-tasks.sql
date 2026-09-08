-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  It is the ONLY database change needed for the Tasks kanban board.
--  Safe to re-run: every statement is idempotent (create if not exists /
--  drop-then-create), so running it twice changes nothing and loses no data.
--
--  What it does
--  ------------
--    * creates the `tasks` table (5 stages, priority, due date, board order)
--    * turns on Row Level Security so that:
--        - a WORKER can see / add / move / edit / delete ONLY their own tasks
--        - the ADMIN has full access to every worker's tasks
--    * adds triggers so a task a worker creates is still owned by the
--      workspace admin (and therefore visible on the admin's board)
--
--  Nothing else needs a migration. In particular "Project Scope" reuses the
--  existing `workers.position` column, so there is no change for it here.
--
--  Requires: schema.sql already applied (for is_admin(), current_worker_id(),
--  workspace_owner_id(), set_user_id(), set_updated_at()). Any existing
--  Work Tracker database already has these.
-- ============================================================================


-- ---------- 1. table ----------
create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_tasks_user below.
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- The worker the task belongs to; deleting a worker removes their tasks.
  worker_id       uuid not null references public.workers (id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 200),
  description     text,
  status          text not null default 'todo'
                    check (status in ('todo','in_progress','waiting','approval','completed')),
  priority        text not null default 'medium'
                    check (priority in ('low','medium','high')),
  due_date        date,
  -- Manual ordering inside a column (smaller sorts first).
  position        integer not null default 0,
  -- Who created it, for the "Assigned by admin" hint on the card.
  created_by_role text not null default 'worker'
                    check (created_by_role in ('admin','worker')),
  -- When it first reached Completed (cleared if it moves back out).
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);


-- ---------- 2. indexes ----------
create index if not exists tasks_user_idx on public.tasks (user_id);
create index if not exists tasks_worker_idx on public.tasks (worker_id);
-- Matches the board's exact query: one worker's column, in board order.
create index if not exists tasks_worker_status_position_idx
  on public.tasks (worker_id, status, position);


-- ---------- 3. stages ----------
-- Re-assert the allowed stages. This is what upgrades a database that ran an
-- earlier 3-stage version of this file (To Do / In Progress / Completed) to
-- also allow Waiting and Approval.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('todo','in_progress','waiting','approval','completed'));


-- ---------- 4. row level security ----------
alter table public.tasks enable row level security;

-- READ: worker sees only rows assigned to them; admin sees the workspace.
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

-- CREATE (admin): may create a task for any worker in their workspace.
drop policy if exists "tasks_insert_admin" on public.tasks;
create policy "tasks_insert_admin" on public.tasks
  for insert with check (
    (select auth.uid()) = user_id and (select public.is_admin())
  );

-- CREATE (worker): may create tasks, but only ever assigned to themselves,
-- and always owned by the workspace admin.
drop policy if exists "tasks_insert_worker" on public.tasks;
create policy "tasks_insert_worker" on public.tasks
  for insert with check (
    worker_id = (select public.current_worker_id())
    and worker_id is not null
    and user_id = (select public.workspace_owner_id())
  );

-- UPDATE: editing a card and dragging it between stages.
drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  )
  with check (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

-- DELETE
drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );


-- ---------- 5. triggers ----------
-- Own every row by the workspace admin, even when a worker inserts it — this
-- is what makes a worker-created task show up on the admin's board.
drop trigger if exists trg_tasks_user on public.tasks;
create trigger trg_tasks_user before insert on public.tasks
  for each row execute function public.set_user_id();

-- Keep updated_at current.
drop trigger if exists trg_tasks_updated on public.tasks;
create trigger trg_tasks_updated before update on public.tasks
  for each row execute function public.set_updated_at();


-- ---------- 6. verify ----------
-- Should return 5 policies and the tasks table with rowsecurity = true.
select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'tasks';
select policyname, cmd from pg_policies where schemaname = 'public' and tablename = 'tasks' order by policyname;
