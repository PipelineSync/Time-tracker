-- ============================================================================
--  WORK TRACKER — RUN THIS ONCE IN SUPABASE
--
--  Copy this whole file into:  Supabase → SQL Editor → New query → Run
--
--  What it does
--  ------------
--  Repeating tasks no longer require QA. A recurring card is routine work that
--  the worker closes themselves — only a ONE-OFF task defaults to "QA
--  Required? Yes". Two things change:
--
--   1. Every task that already repeats is switched to qa_required = false:
--        * a template sitting on the Recurring shelf (`repeats` set), and
--        * every occurrence started / recreated from it (`series_id` set),
--          including completed cards — a "Recreate next" clone carries its
--          card's setting forward, so a Yes left behind would keep gating the
--          whole series.
--      The Owner (or anyone with `team_kpi.view`) can tick Yes back on a
--      recurring card afterwards; this migration never runs twice, so that
--      choice is not undone.
--
--   2. The guard trigger is replaced with one that lets anyone create a
--      REPEATING task without QA (it is the default for them) while keeping
--      every other rule: completing a QA-required task, changing the setting
--      and creating a one-off task without QA still need the Owner or KPI
--      access. The "next occurrence of a series that already has a no-QA
--      card" exemption is unchanged.
--
--  Requires: supabase/RUN-THIS-task-qa-required.sql (the column + trigger) and
--  supabase/recurring-tasks.sql (the repeats / series_id columns). Fresh
--  installs get all of this from schema.sql.
--
--  NOTE — this file re-installs the guard trigger. "QA Required?" is now a
--  request for review that anyone may tick and that never blocks completing a
--  card, so run supabase/RUN-THIS-open-qa-toggle.sql after it (or again, if
--  you re-run this one) to remove the guard.
--
--  Run it once. The schema statements are idempotent, but the data flip is a
--  plain UPDATE: running it again would re-switch any recurring card the Owner
--  has deliberately ticked Yes on since.
-- ============================================================================


-- ---------- 0. prerequisite check ----------
do $$
begin
  if to_regprocedure('public.has_permission(text)') is null then
    raise exception 'Run supabase/worker-permissions.sql and supabase/RUN-THIS-team-kpi.sql first — QA Required relies on their has_permission() helper and team_kpi.view access key.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'repeats'
  ) then
    raise exception 'Run supabase/recurring-tasks.sql first — this migration switches QA off for repeating tasks.';
  end if;
end
$$;


-- ---------- 1. existing repeating tasks become QA-free ----------
-- One-off tasks are untouched: they keep whatever the Owner set.
update public.tasks
   set qa_required = false
 where qa_required
   and (repeats <> 'none' or series_id is not null);


-- ---------- 2. the guard knows about repeating tasks ----------
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
-- Right after the run: repeating_requiring_qa = 0, tasks_requiring_qa counts
-- the one-off tasks that still ask for review, and the guard is installed.
select
  (select count(*) from public.tasks where qa_required and (repeats <> 'none' or series_id is not null))
                                                                   as repeating_requiring_qa,
  (select count(*) from public.tasks where qa_required)            as tasks_requiring_qa,
  exists (
    select 1 from pg_trigger
     where tgrelid = 'public.tasks'::regclass
       and tgname = 'trg_tasks_qa_required'
       and not tgisinternal
  )                                                                as guard_installed;
