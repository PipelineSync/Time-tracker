# Team KPI & Workload Management — Codebase Inspection & Migration Plan

**Status: AWAITING APPROVAL. No schema or code changes have been made.**
Branch: `arena/01a0cb25-time-tracker` · Base: `5bf7a5c` (main) · Date: 2026-09-23 (Asia/Manila)

This document answers the four inspection questions, then proposes the migration for the
task stage and field changes. Section 6 lists every decision I need signed off before I
touch the database.

---

## 1. Current task model, stages and fields

### Stages (`src/lib/types.ts:942`)

```ts
export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'approval' | 'completed'
export const TASK_STATUSES: TaskStatus[] = ['todo','in_progress','waiting','approval','completed']
export const TaskStatusNames = { todo:'To Do', in_progress:'In Progress',
                                 waiting:'Waiting', approval:'Approval', completed:'Completed' }
```

Five stages, not six. **`approval` is the closest thing to "For Review"; there is no
`rework` stage at all.** `TASK_STATUSES` is the single ordering source — the board derives
its columns from it (`TaskBoard.tsx:230`) and the card's ◀ ▶ buttons walk the array by
index (`TaskBoard.tsx:279`), so stage order is also stage *navigation*.

### `Task` fields (`src/lib/types.ts:970`)

| Field | Type | Note |
|---|---|---|
| `id` | string | |
| `worker_id` | string | the assignee |
| `client_id` | string \| null | nullable only for pre-clients rows |
| `title` | string | 1–200 chars |
| `description` | string \| null | |
| `status` | TaskStatus | |
| `priority` | `'low'\|'medium'\|'high'` | |
| `due_date` | string \| null | **optional today** — plain `YYYY-MM-DD`, no time |
| `position` | number | manual order within a column |
| `created_by_role` | `'admin'\|'worker'` | drives the "Assigned by admin" hint |
| `completed_at` | string \| null | stamped on first entry to Completed, cleared if it moves back |
| `archived_at` | string \| null | archive tab |
| `created_at` / `updated_at` | string | |

### What the brief assumes exists but **does not**

> §4: *"Estimated Hours already exist and are the primary workload input."*

**They do not exist.** `grep -rn "estimated" src/ supabase/` returns nothing. There is no
estimate field anywhere in the app, the types, or the database. This is the single
biggest gap: the entire §7 workload calculation depends on a column that has to be added
first, and every existing task will have a null estimate until someone fills them in.

Also absent: QA score, rework flags, waiting reason, stage history, and every timestamp in
§3 except `completed_at`.

### Where stages are persisted (3 SQL CHECK constraints, all must move together)

| File | Line | Statement |
|---|---|---|
| `supabase/schema.sql` | 189 | `check (status in ('todo','in_progress','waiting','approval','completed'))` |
| `supabase/tasks.sql` | 23, 46 | same, + a re-assert `alter table … add constraint` |
| `supabase/RUN-THIS-tasks.sql` | 38, 68 | same (the copy-paste bundle) |

### Board and filtering

- `src/components/TaskBoard.tsx` (1051 lines) — drag & drop kanban, shared by Tasks and
  linked from Dashboard. Archive tab, "See more" description clamp, touch ◀ ▶ moves.
- `src/lib/taskFilters.ts` — `BoardFilters` (worker / stage / client / priority /
  overdueOnly / dueTodayOnly / dueRange / search) **plus a URL round-trip**
  (`boardFiltersToParams` / `boardFiltersFromParams`).

> **This is already the "every number is clickable" pattern the brief asks for in §6.**
> `DashboardPage.goToBoard()` navigates to `/tasks?overdue=1&worker=…` and the board
> re-scopes itself. The KPI page should reuse it verbatim rather than invent a drill-down.

---

## 2. Employees, roles and permissions

### Employees are `Worker` rows (`src/lib/types.ts:13`)

`id, name, email, hourly_rate, status ('active'|'inactive'), position (free-text job
title), avatar_url, payment_methods, qr_code_url, permissions[], created_at, updated_at`

**No `workdays` and no `weekly_capacity_hours`.** `position` is a free-text label
("Senior HubSpot / Web Development" would go here), not a structured role.

### Roles

`type Role = 'admin' | 'worker'` — exactly two. One admin per workspace (the owner; all
rows are owned by `user_id` = the admin's auth uid) plus N workers.

**There is no "Project Manager" role.** The closest thing is a *permission preset* named
`manager` (`types.ts:362`) which is just a ready-made checkbox set, not a stored role.

### Permissions — 20 keys, triple-enforced

`Permission` (`types.ts:126`) is the single source of truth. Enforcement is three-layer
and the repo is proud of it (see `AUDIT_REPORT.md`):

1. **UI** — `can(permission)` from `useStore()`; nav built by `buildNavPlan()` in `src/lib/nav.ts`; routes gated in `App.tsx`.
2. **Backend** — `can()` in `localDb.ts`, `canDo()` in `supabaseDb.ts`. Both refuse independently of the UI.
3. **RLS** — `public.has_permission(text)` in `supabase/worker-permissions.sql`, checked by every policy.

`can()` returns **true for every permission when the account is an admin**
(`store.tsx:389`). So "Owner has everything" is automatic.

**`it_support.manage` is the precedent for a capability the admin must NOT hold.** It is
deliberately excluded from the admin's implicit set (`store.tsx:384`) and gated by
`isItSupport()` instead of `can()` (`src/lib/tickets.ts`). If any KPI capability must be
withheld from a non-owner, this is the pattern to copy.

**Pre-existing drift I found (not caused by this work):** the permission allow-list is
duplicated in four places and one copy is stale.

| Location | Keys |
|---|---|
| `src/lib/types.ts` (SoT) | 20 |
| `supabase/schema.sql` | 20 ✅ |
| `netlify/functions/create-worker.ts` | 20 ✅ |
| `supabase/worker-permissions.sql` | **16 ❌** — missing `invoices.view`, `finance.subscription`, `finance.payroll`, `it_support.manage` |

A workspace that ran `worker-permissions.sql` but not the newer `schema.sql` will have its
CHECK constraint reject those four keys. Adding KPI keys makes this worse, so I propose
fixing it in the same migration (**D10**).

---

## 3. Chart and table components already in use

### Charts — recharts 2.15.4, used in exactly one file

`src/pages/ReportsPage.tsx` imports `ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
Tooltip, CartesianGrid, LineChart, Line, PieChart, Pie, Cell, Legend`. There is a local
`COLORS` array of 8 hex values, and client bars pull their fill from
`clientColorStyles(client.color).chart` so charts match the client badges.

Everything the brief needs in §5 Row 2 and Row 4 is covered: vertical `BarChart`,
horizontal `BarChart` (`layout="vertical"`), and `LineChart` for the trend.

### Cards

| Component | Shape |
|---|---|
| `ui/card.tsx` | shadcn `Card / CardHeader / CardTitle / CardContent` |
| `StatCard.tsx` | label · value · sub · icon chip. Static. |
| `DashboardStatCard.tsx` | **icon chip + big number + label + sub line, whole card is a `<button>` that applies a board filter**, with an `active` ring state and a `hint` tooltip |

`DashboardStatCard` is exactly the §5 Row 1 summary card, minus the "↑ 4% vs last month"
delta line — that's the one addition needed.

### Tables — hand-rolled, no table library, no virtualization

`src/components/WorkloadOverviewTable.tsx` is the direct analogue of the §6 Employee
Performance table and should be the visual template:

- `<section className="rounded-2xl border bg-card">`
- header strip with an icon chip in `bg-primary/10`, title, subtitle, and a legend
- `overflow-x-auto` + `<table className="w-full min-w-[760px] text-sm">`
- `AvatarBubble` + name in the first cell, `worker.position` in the second
- numeric cells `text-center tabular-nums`, muted at zero, coloured when non-zero
- red for the out-of-target column: `text-red-600 dark:text-red-400`
- status pill: `rounded-full border px-2 py-0.5 text-[10px] font-semibold` with
  emerald / amber / rose variants
- **rows are already clickable and re-scope the board**

### Other building blocks

`PageHeader` (title, description, `leading` slot, `children` for top-right buttons),
`AvatarBubble`, `ClientBadge` / `ClientDot`, `ui/badge`, `ui/select`, `ui/tabs`,
`ui/dialog`, `ui/switch`, `EmptyState`, `Skeleton`, `SectionTransition`, `FaqButton`.

### A note on "dark green sidebar, warm off-white background" (§1 Design)

The **default** PipelineSync palette is navy `#06245B` sidebar on cool off-white
`#F8FAFC` (`src/index.css:7-40`). Dark green + warm off-white is the **Christmas seasonal
skin** (`.christmas`: `--sidebar: #113124`, `--background: #FBF7F3`), which is currently
**on by default** and switched off with `VITE_CHRISTMAS_THEME=off`.

So the screen you're describing is the Christmas skin. The right way to "match exactly" is
to build entirely on the semantic tokens (`bg-sidebar`, `bg-background`, `bg-card`,
`text-primary`, `border-border`) — then the KPI page is green today and navy in January,
in step with every other page. **I will not hardcode any green.** (**D11** if you disagree.)

---

## 4. How Time Entries and Payroll are stored

### Time Entries — `TimeEntry` / `public.time_entries`

`worker_id, client_id, project (legacy free text), start_time, end_time, break_minutes,
notes, hourly_rate, total_minutes, earnings, settled_at, created_at, updated_at`

Live clock is a separate `ActiveTimer` row (one per worker, supports client-switching
mid-shift). The store keeps a **bounded newest-first window** in memory (1200 rows admin /
300 worker, `store.tsx:59`) with `loadOlderEntries()` paging.

> **There is no link between a time entry and a task.** No `task_id` column, no join table.
> §16's "Time Entries → optional estimate-vs-actual validation" is therefore **not
> computable today**. Since §7 says logged hours must not be a core KPI, I propose deferring
> this entirely (**D9**).

### Payroll — two separate concepts

**(a) `Payment` / `public.payments` — settlements.**
`worker_id, amount, hours, status ('unpaid'|'pending'|'paid'), period_start, period_end,
paid_at, note, payment_method, reference_number`. Created by `settleWorker()`, which sums
the worker's unsettled entries and stamps `settled_at` on them (it never deletes time).

**(b) `FinanceItem` with `kind: 'payroll'` / `public.finance_items` — the monthly ledger line.**
`worker_id, amount, period_month ('YYYY-MM'), due_date, status, paid_at, payment_method`.
`suggestedPayroll()` in `src/lib/finance.ts` proposes an amount from tracked earnings.

Gated by `payments.view_all` / `payments.manage` / `finance.payroll` / `finance.manage`.

> §15 says KPI must **never** automatically change payroll. Neither of these tables has any
> notion of a bonus. I propose a **separate** `kpi_bonus_reviews` table that is written only
> by an explicit Owner action and **never** read by the payroll code — so there is no code
> path at all from a KPI score to a payment amount (**D8**).

---

## 5. Architecture constraints this feature must respect

1. **Dual backend.** Every data feature is implemented **twice** behind the `DataBackend`
   interface (`src/lib/backend.ts`): `src/lib/localDb.ts` (demo mode, localStorage) and
   `src/lib/supabaseDb.ts`. The store (`src/lib/store.tsx`, 1724 lines) is the only thing
   the UI touches. A KPI feature that only works on Supabase would break demo mode.
2. **Defensive reads.** `supabaseDb.ts` has `isMissingColumn()` / `isMissingTable()` and
   retries the query without the new column. This is how the app keeps running *before* a
   migration is applied. New columns must follow this so nobody gets a broken app between
   deploy and SQL run.
3. **Migrations are hand-run SQL files.** No migration tool. Convention: an idempotent
   `supabase/<feature>.sql`, mirrored into `schema.sql` for fresh installs, plus a
   `RUN-THIS-*.sql` copy-paste bundle for the operator. Everything is
   `create … if not exists` / `drop … then create`.
4. **No test runner.** No vitest, no jest. The convention is standalone
   `scripts/verify-*.ts` executed with `tsx`, using a tiny `assert(cond, msg)` helper and a
   localStorage stub, aggregated by `npm run verify`. **I will follow this convention for
   the §17 "automated tests for every calculation" requirement** unless you want vitest
   introduced (**D12**).
5. Baseline is green: `npm run typecheck` and `npm run lint` both pass on a clean checkout.

---

## 6. Proposed migration plan — stages and fields

### 6.1 Stage mapping (for your approval — §3 asks me to list this)

| Current value | New value | New label | Rows affected | Backfill |
|---|---|---|---|---|
| `todo` | `todo` | To Do | unchanged | `assigned_at := created_at` |
| `in_progress` | `in_progress` | In Progress | unchanged | `assigned_at := created_at`; `started_at := updated_at` |
| `waiting` | `waiting` | Waiting | unchanged | `waiting_since := updated_at`; `waiting_reason := null` ("Other" on next edit) |
| `approval` | **`for_review`** | For Review | **renamed** | `submitted_for_review_at := updated_at` |
| `completed` | `completed` | Completed | unchanged | `completed_at` already correct |
| — | **`rework`** | Rework | new, 0 rows | — |

New order: `todo → in_progress → waiting → for_review → rework → completed`.

**The `approval` → `for_review` rename reaches 20 files.** Most are cosmetic, but three
are not:

- **Slack event keys** `task_approval_created` / `task_approval_moved` and the Slack
  channel key `'approval'` (`src/lib/slack.ts`, `netlify/functions/slack-notify.ts`,
  `supabase/slack_settings` columns `approval_webhook_url`, `notify_task_approval_*`).
  These are **stored settings and a deployed function contract**. Renaming them means a
  second migration and a Netlify redeploy for zero user benefit.
  **Recommendation: rename the task *stage* only; leave the Slack channel called
  "Approval" and its columns untouched.** The channel keeps firing on `for_review`.
- The three SQL CHECK constraints (listed in §1) — must be dropped and re-added in the
  same transaction as the `update tasks set status='for_review' where status='approval'`.
- `normalizeTaskStatus()` in `localDb.ts:188` defaults anything unknown to `'todo'`.
  Demo-mode blobs in a user's browser still holding `'approval'` would **silently become
  To Do**. I will add an explicit legacy remap there *before* the default kicks in.

### 6.2 New columns on `tasks` (all nullable or defaulted → existing rows stay valid)

| Column | Type | Purpose |
|---|---|---|
| `estimated_hours` | `numeric(6,2)` null | §4/§7 — the workload input. Null = not estimated. |
| `assigned_at` | `timestamptz` null | §3. Backfill `created_at`. |
| `started_at` | `timestamptz` null | §3 |
| `waiting_since` | `timestamptz` null | §3/§12 |
| `submitted_for_review_at` | `timestamptz` null | §3 |
| `rework_started_at` | `timestamptz` null | §3 |
| `waiting_reason` | `text` null + CHECK | §12, 7 values |
| `qa_score` | `smallint` null CHECK 1–5 | §10 |
| `rework_required` | `boolean` not null default `false` | §4 |
| `rework_type` | `text` null + CHECK | §11, 10 values, 5 "counts against" + 5 "does not" |
| `reviewed_by` / `reviewed_at` | `uuid` / `timestamptz` null | §12 "Reviewer Responsible", §15 audit |
| `original_due_date` | `date` null | §15. Backfill `= due_date`. On-time uses this. |
| `due_date_change_reason` | `text` null | §15 — if it's a non-employee cause, the new date is allowed to count |

"Legacy / No Due Date" (§4) is **derived, not stored**: `due_date is null`. Those rows are
excluded from on-time maths. No column needed.

### 6.3 New columns on `workers`

| Column | Type | Purpose |
|---|---|---|
| `workdays` | `smallint[]` not null default `'{1,2,3,4,5}'` | §2. 0=Sun … 6=Sat. Tue–Sat = `{2,3,4,5,6}`. |
| `weekly_capacity_hours` | `numeric(5,2)` not null default `40` | §2 |

Columns on `workers` rather than a `worker_schedules` table — same shape as how
`permissions` was added, one fewer join, and the worker row is already loaded everywhere.

### 6.4 New tables

| Table | Key columns | Why |
|---|---|---|
| `task_stage_events` | `task_id, from_status, to_status, changed_by, changed_by_name, changed_at` | §3 "preserve full stage history (who, from, to, when)" |
| `task_audit_events` | `task_id, field, old_value, new_value, actor, actor_name, at, reason` | §15 audit for QA scores, rework classification, due-date changes |
| `kpi_goals` | `worker_id, period_month, label, target_value, achieved_value, updated_by` | §9 per-employee monthly targets, set via "Manage Goals" |
| `kpi_settings` | one row per workspace: 4 weights, 4 targets, workload band edges, behind-pace margin, QA/rework conversion params | §8 "store weights and targets as configurable settings (Owner-only)" |
| `kpi_bonus_reviews` | `worker_id, period_month, bonus_eligible ('yes'\|'no'\|'pending'), approved_amount, approved_by, approved_at, note` | §15, deliberately isolated from `payments` / `finance_items` |

All get `user_id` (workspace owner) + the standard `set_user_id` / `set_updated_at`
triggers + RLS mirroring the existing pattern.

### 6.5 New permissions

| Key | Holder | Gates |
|---|---|---|
| `team_kpi.view` | Owner (implicit) + PM | the Team KPI page, read-only |
| `team_kpi.manage` | Owner (implicit) + PM | QA scoring, rework classification, Manage Goals |
| *(bonus)* | **Owner only — `isAdmin`, not a permission** | approving / editing bonus decisions |

§14 says bonus editing is Owner-only. A permission key would be *grantable* by any worker
holding `workers.manage`, so it would not actually be Owner-only. Gating on `isAdmin`
directly is the only way to honour §14/§15 (**D7**).

§14 also says employees must not reach the page *server-side*: both backends will refuse
the KPI reads without `team_kpi.view`, and the RLS policies on the new tables will check
`has_permission('team_kpi.view')` — same triple-layer as everything else.

### 6.6 Files the migration touches

```
supabase/team-kpi.sql               NEW — the whole migration, idempotent
supabase/RUN-THIS-team-kpi.sql      NEW — copy-paste bundle for the operator
supabase/schema.sql                 stages CHECK, new columns, new tables (fresh installs)
supabase/tasks.sql                  stages CHECK
supabase/RUN-THIS-tasks.sql         stages CHECK
supabase/worker-permissions.sql     allow-list: + 4 stale keys + 2 KPI keys  (see D10)
netlify/functions/create-worker.ts  allow-list: + 2 KPI keys
src/lib/types.ts                    TaskStatus, TASK_STATUSES, TaskStatusNames, Task,
                                    Worker, Permission, PERMISSION_GROUPS, presets
src/lib/localDb.ts                  legacy 'approval' remap, new fields, KPI CRUD
src/lib/supabaseDb.ts               defensive reads for every new column, KPI CRUD
src/lib/backend.ts                  DataBackend interface additions
src/lib/store.tsx                   state + actions
src/lib/nav.ts + AppLayout.tsx      'teamKpi' between tasksAll and invoicing
src/App.tsx                         /team-kpi route behind can('team_kpi.view')
```

---

## 7. Formula conversions proposed for approval (§7, §8, §12 ask for these)

**KPI Score** = `0.30·onTime + 0.30·qa + 0.25·goal + 0.15·reworkPerf` (weights configurable).

**(a) QA 1–5 → %** — proposed `qa% = (avg QA score / 5) × 100`
so 5→100, 4→80, 3→60. The 90% target means an average of 4.5/5.
*(Alternative considered: `(s−1)/4×100`, which makes 1→0 and needs 4.6/5 for target. I
prefer /5 because "4 out of 5 = 80%" is what a reviewer intuitively expects.)* → **D3**

**(b) Rework rate → performance score** — proposed
`reworkPerf = clamp(0, 100, 100 − max(0, reworkRate% − 5) × 5)`
At or under the 5% target = 100. 8% → 85. 10% → 75. 25% → 0. Both the `5` target and the
`5×` penalty factor live in `kpi_settings`. → **D4**

*Sanity check against your illustrative §6 table:* Mary (on-time 84, QA 89, rework 8% → 85)
needs goal ≈ 69 to land on KPI 82. Jasper (94, 93, 4% → 100) needs goal ≈ 76 for KPI 90.
April (95, 96, 2% → 100) needs goal ≈ 79 for KPI 92. All plausible — the formula is
consistent with your example numbers.

**(c) Goal** = `min(100, achieved / target × 100)`. "Behind pace" (§13) =
`progress% < elapsedWorkdays% − margin`, margin default 10 pts, configurable.

**(d) On-time, blocked-adjusted (§12)** — proposed
`onTime = completed_at ≤ original_due_date + (business days spent in Waiting for a
non-employee cause)`, counted in the **assignee's** workdays. Non-employee causes = the
five §11 "does not count" reasons, mapped to waiting reasons: Waiting on Client, Waiting on
Manager, Waiting on Access, Waiting on Approval, External Dependency. → **D5** covers
whether *Waiting on Teammate* is also excused.
Tasks with no due date are excluded from the denominator entirely.

**(e) Workload (§7)** — documented in code as:
```
openEstimatedHours = Σ estimated_hours over stages [todo, in_progress, waiting, for_review, rework]
dailyCapacity      = weekly_capacity_hours / workdays.length      // 40/5 = 8
availableHours     = remainingWorkdaysInPeriod(assignee.workdays) × dailyCapacity
workload%          = openEstimatedHours / availableHours × 100
```
Bands: <60 Available · 60–80 Normal · 81–100 High Workload · >100 Overloaded.
Two edges need a ruling: whether Waiting/For Review count as load (**D1**), and what the
capacity window is for a past or fully-elapsed month (**D2**).

---

## 8. Decisions I need from you

Each has a recommendation. **Reply "defaults" to take all of them**, or override by number.

| # | Decision | My recommendation |
|---|---|---|
| **D1** | Do `waiting` and `for_review` tasks count toward workload %? | **Yes, count them.** They still occupy the employee's plate and §12 handles the fairness side separately (blocked time is excused from *on-time*, not from *load*). Showing a blocked person as "Available" would mislead. |
| **D2** | Capacity window when the selected month is past or fully elapsed | **Current month → remaining workdays from today (inclusive). Past/future month → all workdays in that month.** If remaining = 0 on the last workday, fall back to 1 day rather than showing ∞. |
| **D3** | QA 1–5 → % conversion | `score / 5 × 100` |
| **D4** | Rework rate → performance score | `100 − max(0, rate% − 5) × 5`, clamped 0–100 |
| **D5** | Is "Waiting on Teammate" excused from on-time? | **Yes, excuse it.** It is outside *this* employee's control, which is the §12 test. |
| **D6** | Board ◀ ▶ order with Rework between For Review and Completed | **Special-case it:** forward from Rework goes back to **For Review** (per §10's loop), not to Completed. Linear order everywhere else. |
| **D7** | How is "Owner-only" bonus approval enforced? | **`isAdmin` directly, not a permission key.** A permission would be grantable by any worker with `workers.manage`, defeating §14. |
| **D8** | Bonus data location | **Own `kpi_bonus_reviews` table, never read by payroll code**, so no code path exists from KPI score to a payment (§15). |
| **D9** | Estimate-vs-actual from Time Entries | **Defer.** Requires adding `task_id` to `time_entries` and a task picker at clock-in — a feature in its own right, and §7 says logged hours must not be a core KPI. |
| **D10** | Fix the stale `worker-permissions.sql` allow-list (missing 4 existing keys) while adding the 2 KPI keys? | **Yes.** It's a 4-line fix in the file I'm already editing, and leaving it means KPI grants fail on some installs. |
| **D11** | "Dark green sidebar / warm off-white" | **Use semantic tokens, hardcode nothing.** Green today via the Christmas skin, navy when it's switched off — always in step with the rest of the app. |
| **D12** | Test approach for §17 | **Follow the repo: `scripts/verify-kpi-*.ts` run by `tsx`**, added to `npm run verify`. Introducing vitest would be the only untested tooling change in the PR. |

### Two things in the brief that need your call, not just a default

- **§4 "Estimated Hours already exist"** — they don't. Every existing task will have a
  **null estimate**, so workload % is uncomputable for the whole backlog on day one.
  How do you want to handle the gap? (a) treat null as 0 hours and show a "N tasks
  un-estimated" warning on the card, (b) block the KPI page until estimates are filled,
  (c) apply a default estimate per priority (e.g. high 8h / medium 4h / low 2h) that the
  Owner can change. **I'd recommend (a)** — honest, non-blocking, and it nudges people to
  fill the field in.
- **The five named employees in §2** — demo mode currently seeds John Smith / Sarah
  Johnson / Mike Brown. Do you want the demo seed replaced with Jasper / Matthew / Jea /
  April / Mary (with the right workdays, so the Tue–Sat logic is visible immediately), or
  left alone because the real workspace already has these five in Supabase?

---

## 9. Build order once approved (§17)

Priority 1 is the only one that needs no schema change, so I can start there the moment
you approve the plan; everything from priority 2 onward waits on the SQL sign-off.

1. Team KPI nav + page shell + permissions (triple-layer) — **no schema change**
2. Stage standardisation + the `approval → for_review` migration + `rework`
3. Due Date required for new tasks; legacy exception preserved
4. Task timestamps + `task_stage_events` history
5. Schedule-aware workload from estimated hours
6. Summary cards, employee table, charts, trend, goals, Needs Attention
7. QA + rework review flow
8. Monthly role-specific targets
9. Review backlog reporting
10. Bonus review fields + audit trail

After each one I'll stop and report: files changed, schema changes, how to test manually,
and any open decisions — as you asked.
