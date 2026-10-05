-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--    * adds the `qa_required` column to `tasks` — the "QA Required?  Yes / No"
--      tick box on a task:
--        Yes  a worker CANNOT move the task to Completed. Only the Owner and
--             people with KPI access (`team_kpi.view`) can — normally through
--             the QA review of a card in For Review.
--        No   the worker can move the task to Completed themselves.
--    * every task that already exists is set to No, so nothing on the board is
--      locked retroactively. New ONE-OFF tasks default to Yes; a REPEATING
--      task (the Recurring shelf's templates and their occurrences) defaults
--      to No, so routine work is completed by the worker — see
--      supabase/RUN-THIS-recurring-no-qa.sql to switch the repeating cards
--      that already exist.
--    * installs a guard trigger on `tasks`, so the rule holds for every way of
--      writing to the table (the app, the Claude connector, a hand-made API
--      request), not only the screens. For anyone WITHOUT KPI access it refuses
--        - moving a QA-required task into Completed,
--        - changing a task's QA Required setting,
--        - creating a one-off task without QA. Two exceptions, both about
--          repeating work: a repeating task is QA-free by default (the worker
--          completes each occurrence), and the next occurrence of a series
--          whose earlier cards already had no QA carries that setting forward.
--      The Owner, anyone with `team_kpi.view`, and the SQL editor / service
--      role (no signed-in user) are never blocked.
--
--  Safe to re-run: every statement is idempotent, so running it twice changes
--  nothing and loses no data. Fresh installs get all of it from schema.sql.
--  Until this runs the app still works — tasks save as before, but nothing can
--  be enforced (every task reads as "No QA").
--
--  Prerequisite: supabase/RUN-THIS-team-kpi.sql (the `team_kpi.view` access key,
--  which in turn needs supabase/worker-permissions.sql for has_permission()).
--
--  NOTE — the guard trigger is no longer wanted. "QA Required?" is now a
--  request for review that anyone may tick and that never blocks completing a
--  card, so after this file (which still installs the trigger for older
--  setups) run supabase/RUN-THIS-open-qa-toggle.sql to remove it. Re-running
--  this file later re-installs the trigger; run the open-qa-toggle file again
--  to take it back off.
-- ============================================================================


-- ---------- 0. prerequisite check ----------
-- The guard below asks has_permission() who holds KPI access. Without it the
-- trigger would fail on every task write, so stop here with a clear message
-- instead of installing it.
do $$
begin
  if to_regprocedure('public.has_permission(text)') is null then
    raise exception 'Run supabase/worker-permissions.sql and supabase/RUN-THIS-team-kpi.sql first — QA Required relies on their has_permission() helper and team_kpi.view access key.';
  end if;
end
$$;


-- ---------- 1. the column ----------
-- Two steps on purpose. Adding the column with `default false` stamps every
-- existing task "No QA" (legacy work is not locked retroactively); only then
-- does the default flip to true for tasks created from now on.
alter table public.tasks add column if not exists qa_required boolean not null default false;
alter table public.tasks alter column qa_required set default true;


-- ---------- 2. the guard ----------
create or replace function public.enforce_task_qa_required()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- The three things this guard cares about:
  v_changes_flag boolean := false;   -- an existing task's QA Required setting is being changed
  v_creates_no_qa boolean := false;  -- a new task is being created WITHOUT QA
  v_completes_qa boolean := false;   -- a QA-required task is arriving in Completed (new, or from another stage)
  v_series text;
  v_repeats text;
begin
  -- (OLD only exists on UPDATE, so it is only ever read inside this branch.)
  if tg_op = 'UPDATE' then
    v_changes_flag := new.qa_required is distinct from old.qa_required;
    v_completes_qa := new.qa_required is true and new.status = 'completed' and old.status is distinct from 'completed';
  else
    v_creates_no_qa := new.qa_required is not true;
    v_completes_qa := new.qa_required is true and new.status = 'completed';
  end if;

  -- Fast path: almost every write (re-ordering a column, moving a card between
  -- other stages, editing a title) touches none of the above.
  if not (v_changes_flag or v_creates_no_qa or v_completes_qa) then
    return new;
  end if;

  -- The SQL editor, migrations and the service role have no signed-in user;
  -- the Owner and anyone with KPI access decide QA (has_permission() is true
  -- for the Owner).
  if auth.uid() is null or public.has_permission('team_kpi.view') then
    return new;
  end if;

  if v_changes_flag then
    raise exception 'Only the Owner or someone with KPI access can change whether a task requires QA.'
      using errcode = '42501';
  end if;

  if v_creates_no_qa then
    -- A worker's own tasks are created with QA, with two exemptions: a
    -- REPEATING task is QA-free by default (its worker completes each
    -- occurrence), and the next occurrence of a series that already has a
    -- no-QA card just carries the series' setting forward. (to_jsonb() so this
    -- keeps working on a database without the recurring-task columns.)
    v_series := to_jsonb(new) ->> 'series_id';
    v_repeats := coalesce(to_jsonb(new) ->> 'repeats', 'none');
    if v_repeats = 'none' and (v_series is null or not exists (
      select 1
        from public.tasks s
       where s.qa_required is false
         and (s.id::text = v_series or to_jsonb(s) ->> 'series_id' = v_series)
    )) then
      raise exception 'Only the Owner or someone with KPI access can create a task without QA.'
        using errcode = '42501';
    end if;
  end if;

  if v_completes_qa then
    raise exception 'This task requires QA — only the Owner or someone with KPI access can move it to Completed.'
      using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists trg_tasks_qa_required on public.tasks;
create trigger trg_tasks_qa_required
  before insert or update on public.tasks
  for each row execute function public.enforce_task_qa_required();


-- ---------- 3. verify ----------
-- One row. Right after the first run: tasks_requiring_qa = 0 (everything that
-- existed is "No"), tasks_without_qa = your current task count, and
-- guard_installed = true.
select
  (select count(*) from public.tasks where qa_required)     as tasks_requiring_qa,
  (select count(*) from public.tasks where not qa_required) as tasks_without_qa,
  exists (
    select 1 from pg_trigger
     where tgrelid = 'public.tasks'::regclass
       and tgname = 'trg_tasks_qa_required'
       and not tgisinternal
  )                                                          as guard_installed;
