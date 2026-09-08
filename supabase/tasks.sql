-- ============================================================
-- Work Tracker — Tasks (kanban board)
--
-- Run this in the Supabase SQL editor on an existing database to add the
-- Tasks section. New databases get it from supabase/schema.sql, which
-- contains the same statements. Safe to re-run.
--
-- Access model (mirrors the rest of the app):
--   * a worker sees, adds, moves, edits, and deletes ONLY their own tasks
--   * the admin has full access to every worker's tasks
-- Rows are owned by the workspace admin (user_id), exactly like time_entries,
-- so the admin's board can read a task a worker created from their own login.
-- ============================================================

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  -- Workspace owner (the admin). Set automatically by trg_tasks_user.
  user_id         uuid not null references auth.users (id) on delete cascade,
  -- The worker the task belongs to; deleting a worker removes their tasks.
  worker_id       uuid not null references public.workers (id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 200),
  description     text,
  status          text not null default 'todo' check (status in ('todo','in_progress','waiting','approval','completed')),
  priority        text not null default 'medium' check (priority in ('low','medium','high')),
  due_date        date,
  -- Manual ordering inside a column (smaller sorts first).
  position        integer not null default 0,
  -- Who created it, for the "Added by admin" hint on the card.
  created_by_role text not null default 'worker' check (created_by_role in ('admin','worker')),
  -- When it first reached the Completed column (cleared if it moves back).
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tasks_user_idx on public.tasks (user_id);
create index if not exists tasks_worker_idx on public.tasks (worker_id);
-- The board's exact query: one worker's column, in board order.
create index if not exists tasks_worker_status_position_idx
  on public.tasks (worker_id, status, position);

-- Databases that ran the earlier 3-stage version of this migration: widen the
-- allowed stages to include Waiting and Approval.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('todo','in_progress','waiting','approval','completed'));

alter table public.tasks enable row level security;

-- ---------- policies ----------
-- Worker: only rows assigned to them. Admin: the whole workspace.
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
  for select using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

-- The admin may create a task for any worker in their workspace.
drop policy if exists "tasks_insert_admin" on public.tasks;
create policy "tasks_insert_admin" on public.tasks
  for insert with check ((select auth.uid()) = user_id and (select public.is_admin()));

-- A worker may create tasks, but only ever assigned to themselves and owned by
-- the workspace admin (trg_tasks_user forces user_id, this double-checks it).
drop policy if exists "tasks_insert_worker" on public.tasks;
create policy "tasks_insert_worker" on public.tasks
  for insert with check (
    worker_id = (select public.current_worker_id())
    and worker_id is not null
    and user_id = (select public.workspace_owner_id())
  );

-- Editing / dragging between columns.
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

drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
  for delete using (
    ((select auth.uid()) = user_id and (select public.is_admin()))
    or worker_id = (select public.current_worker_id())
  );

-- ---------- triggers ----------
-- Own the row by the workspace admin, even when a worker inserts it.
drop trigger if exists trg_tasks_user on public.tasks;
create trigger trg_tasks_user before insert on public.tasks
  for each row execute function public.set_user_id();

drop trigger if exists trg_tasks_updated on public.tasks;
create trigger trg_tasks_updated before update on public.tasks
  for each row execute function public.set_updated_at();
