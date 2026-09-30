/**
 * Verification of the Team KPI formula:
 *
 *     KPI = 40% On-Time + 40% QA + 20% Monthly Goal      (rework is no longer scored)
 *
 * and of the Monthly Goal, which is worked out per KPI role:
 *
 *   project               80% planned new-client/project work + 20% recurring/internal work
 *                         (Jasper & Matthew)
 *   maintenance_outreach  70% maintenance tasks + 30% outreach / other assigned work
 *                         (Jea & Joy)
 *   social_media          60% recurring social media tasks + 40% planned content deliverables
 *                         (Mary)
 *   (no role)             tasks completed ÷ the typed Tasks plan, exactly as before
 *
 * Each side is "completed ÷ tasks due that month". Recurring tasks and tasks for
 * the Internal client are the recurring side; every other task is planned work.
 *
 * This file checks the pure engine (src/lib/kpi.ts) on hand-built tasks, then the
 * demo-mode backend (KPI roles stored on workers + the seeded team).
 *
 * Run: npx tsx scripts/verify-kpi-goals-local.ts
 */
// Minimal browser stub so storage.ts works in Node.
const mem = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
}

import type { KpiRole, MonthlyGoal, Task, Worker } from '../src/lib/types'

let failures = 0
const assert = (cond: unknown, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

// ---------------------------------------------------------------- fixtures
const MONTH = '2026-05' // 31 days; May 1 is a Friday
const pad = (n: number) => String(n).padStart(2, '0')
const day = (n: number) => `${MONTH}-${pad(n)}`
const NOW = new Date(2026, 5, 15) // mid-June: May is a finished month

let seq = 0
function task(over: Partial<Task> & { worker_id: string }): Task {
  seq += 1
  return {
    id: `t${seq}`,
    client_id: 'c-acme',
    title: `Task ${seq}`,
    description: null,
    status: 'todo',
    priority: 'medium',
    start_date: day(1),
    due_date: null,
    original_due_date: null,
    estimated_hours: null,
    qa_required: true,
    repeats: 'none',
    repeat_until: null,
    series_id: null,
    occurrence: null,
    assigned_at: null,
    started_at: null,
    waiting_since: null,
    submitted_for_review_at: null,
    rework_started_at: null,
    waiting_reason: null,
    qa_score: null,
    qa_reviewed_at: null,
    qa_reviewed_by: null,
    rework_required: null,
    rework_type: null,
    rework_notes: null,
    stage_history: [],
    position: 0,
    created_by_role: 'admin',
    completed_at: null,
    archived_at: null,
    created_at: `${MONTH}-01T00:00:00.000Z`,
    updated_at: `${MONTH}-01T00:00:00.000Z`,
    ...over,
  } as Task
}
/** A completed, QA-scored (5/5) card: finished on `on`, reviewed the same day. */
const finished = (on: string) => ({
  status: 'completed' as const,
  completed_at: `${on}T10:00:00.000Z`,
  qa_score: 5 as const,
  qa_reviewed_at: `${on}T10:00:00.000Z`,
})
const weekly = (n: number) => ({ repeats: 'weekly' as const, series_id: 's-series', occurrence: n })

const worker = (id: string, role: KpiRole | null): Worker => ({
  id, name: id, email: null, hourly_rate: 0, status: 'active', position: null, avatar_url: null,
  payment_methods: [], qr_code_url: null, permissions: [], workdays: [1, 2, 3, 4, 5],
  weekly_capacity_hours: 40, color: null, kpi_role: role, created_at: '', updated_at: '',
})

/** n tasks due in May (one a day from the 1st): the first `doneCount` are finished on their due day. */
function batch(workerId: string, n: number, doneCount: number, extra: Partial<Task> = {}): Task[] {
  return Array.from({ length: n }, (_, i) =>
    task({
      worker_id: workerId,
      due_date: day(1 + i),
      ...(i < doneCount ? finished(day(1 + i)) : {}),
      ...extra,
    }),
  )
}

async function main() {
  const kpi = await import('../src/lib/kpi')
  const types = await import('../src/lib/types')
  const INTERNAL = new Set<string>(['c-internal'])
  const compute = (w: Worker, tasks: Task[], goal: MonthlyGoal | null = null, now = NOW) =>
    kpi.computeEmployeeKpi({ worker: w, tasks, month: MONTH, goal, internalClientIds: INTERNAL, now })

  // ---------------------------------------------------------------- 1. the weights
  console.log('\n--- 1. 40% On-Time + 40% QA + 20% Monthly Goal ---')
  assert(kpi.KPI_WEIGHTS.onTime === 0.4 && kpi.KPI_WEIGHTS.qa === 0.4 && kpi.KPI_WEIGHTS.goal === 0.2, 'the weights are 0.4 / 0.4 / 0.2')
  assert(!('rework' in kpi.KPI_WEIGHTS), 'rework has no share of the score any more')
  assert(Math.abs(kpi.KPI_WEIGHTS.onTime + kpi.KPI_WEIGHTS.qa + kpi.KPI_WEIGHTS.goal - 1) < 1e-9, 'the weights add up to 100%')
  assert(kpi.kpiWeightsLabel() === '40 / 40 / 20', 'the dashboard label reads "40 / 40 / 20"')
  assert(kpi.weightedKpiScore({ onTime: 90, qa: 80, goal: 100 }) === 88, '90 on-time, 80 QA, 100 goal → 0.4×90 + 0.4×80 + 0.2×100 = 88')
  assert(kpi.weightedKpiScore({ onTime: 100, qa: 100, goal: 92 }) === 98, '100 / 100 / 92 → 40 + 40 + 18.4 = 98.4, shown as 98')
  assert(kpi.weightedKpiScore({ onTime: 90, qa: 80, goal: null }) === 85, 'no goal → on-time and QA split the score 50/50 (85), never a fake 0')
  assert(kpi.weightedKpiScore({ onTime: null, qa: 70, goal: 100 }) === 80, 'no on-time → QA 40 + goal 20 renormalised: (28 + 20) ÷ 0.6 = 80')
  assert(kpi.weightedKpiScore({ onTime: null, qa: null, goal: null }) === null, 'nothing to judge → no score')

  // ---------------------------------------------------------------- 2. the role formulas
  console.log('\n--- 2. the three role formulas ---')
  const weightOf = (role: KpiRole, key: 'planned' | 'recurring') => kpi.KPI_ROLE_GOALS[role].find((b) => b.key === key)!.weight
  assert(weightOf('project', 'planned') === 0.8 && weightOf('project', 'recurring') === 0.2, 'Jasper & Matthew: 80% planned new-client/project + 20% recurring/internal')
  assert(weightOf('maintenance_outreach', 'recurring') === 0.7 && weightOf('maintenance_outreach', 'planned') === 0.3, 'Jea & Joy: 70% maintenance + 30% outreach/other')
  assert(weightOf('social_media', 'recurring') === 0.6 && weightOf('social_media', 'planned') === 0.4, 'Mary: 60% recurring social media + 40% planned content')
  for (const role of types.KPI_ROLES) {
    const sum = kpi.KPI_ROLE_GOALS[role].reduce((s, b) => s + b.weight, 0)
    assert(Math.abs(sum - 1) < 1e-9, `${role}: the two weights add up to 100%`)
  }
  assert(kpi.describeKpiRole('maintenance_outreach') === '70% maintenance tasks + 30% outreach / other assigned work', 'describeKpiRole reads naturally')
  assert(types.normalizeKpiRole('project') === 'project' && types.normalizeKpiRole('wizard') === null && types.normalizeKpiRole(null) === null && types.normalizeKpiRole(undefined) === null, 'normalizeKpiRole keeps the three roles and drops anything else')

  // ---------------------------------------------------------------- 3. the worked examples
  console.log('\n--- 3. worked examples (Jea: 95% + 85% = 92%) ---')
  // Jea: 20 maintenance (recurring) tasks due in May, 19 done = 95%; 20 outreach /
  // other (one-off) tasks due in May, 17 done = 85%.
  const jeaTasks = [
    ...batch('jea', 20, 19, weekly(1)),
    ...batch('jea', 20, 17),
  ]
  const jeaGoal = kpi.computeRoleGoal('maintenance_outreach', 'jea', jeaTasks, MONTH, INTERNAL)
  const maint = jeaGoal.buckets.find((b) => b.key === 'recurring')!
  const outreach = jeaGoal.buckets.find((b) => b.key === 'planned')!
  assert(maint.pct === 95 && maint.done === 19 && maint.planned === 20, 'maintenance completion is 95% (19 of 20)')
  assert(outreach.pct === 85 && outreach.done === 17 && outreach.planned === 20, 'outreach / other completion is 85% (17 of 20)')
  assert(jeaGoal.pct === 92, `Monthly Goal = 0.7 × 95 + 0.3 × 85 = 92 (got ${jeaGoal.pct})`)
  const jea = compute(worker('jea', 'maintenance_outreach'), jeaTasks)
  assert(jea.goalMode === 'role' && jea.scoreParts.goal === 92 && jea.goalAchievement === 0.92, 'the employee row carries the same 92% goal')
  assert(jea.goalTarget === 40 && jea.goalAchieved === 36, 'and the totals behind it: 36 of 40 tasks due this month are done')
  assert(jea.onTimePct === 100 && jea.qaPct === 100 && jea.score === 98, `score = 0.4×100 + 0.4×100 + 0.2×92 = 98 (got ${jea.score})`)

  // Jasper & Matthew: planned 9/10 = 90%, recurring/internal 5/10 = 50% → 0.8×90 + 0.2×50 = 82.
  const jasperTasks = [...batch('jasper', 10, 9), ...batch('jasper', 10, 5, weekly(1))]
  assert(compute(worker('jasper', 'project'), jasperTasks).scoreParts.goal === 82, 'project role: 0.8 × 90 + 0.2 × 50 = 82')
  assert(compute(worker('matthew', 'project'), jasperTasks.map((t) => ({ ...t, worker_id: 'matthew' }))).scoreParts.goal === 82, 'Matthew gets the same formula as Jasper')
  // Mary: recurring social 10/10 = 100%, planned content 5/10 = 50% → 0.6×100 + 0.4×50 = 80.
  const maryTasks = [...batch('mary', 10, 10, weekly(1)), ...batch('mary', 10, 5)]
  assert(compute(worker('mary', 'social_media'), maryTasks).scoreParts.goal === 80, 'social media role: 0.6 × 100 + 0.4 × 50 = 80')
  // The same tasks score differently under a different role: the role picks the weights.
  assert(compute(worker('mary', 'project'), maryTasks).scoreParts.goal === 60, 'the same tasks under the project role weigh planned work 80%: 0.8 × 50 + 0.2 × 100 = 60')

  // ---------------------------------------------------------------- 4. which bucket a task belongs to
  console.log('\n--- 4. recurring vs planned ---')
  const plain = task({ worker_id: 'x', due_date: day(5) })
  assert(kpi.goalBucketOf(plain, INTERNAL) === 'planned', 'a one-off task for a normal client is planned work')
  assert(kpi.goalBucketOf(task({ worker_id: 'x', ...weekly(3) }), INTERNAL) === 'recurring', 'a started occurrence of a repeating task is recurring work')
  assert(kpi.goalBucketOf(task({ worker_id: 'x', repeats: 'monthly' }), INTERNAL) === 'recurring', 'a repeating task is recurring work')
  assert(kpi.goalBucketOf(task({ worker_id: 'x', series_id: 's1' }), INTERNAL) === 'recurring', 'a card that belongs to a series is recurring work')
  assert(kpi.goalBucketOf(task({ worker_id: 'x', client_id: 'c-internal' }), INTERNAL) === 'recurring', 'a one-off task for the Internal client is on the recurring/internal side')
  assert(kpi.goalBucketOf(task({ worker_id: 'x', client_id: null }), INTERNAL) === 'planned', 'a task with no client is planned work')
  const ids = kpi.internalClientIdsOf([{ id: 'c1', name: ' internal ' }, { id: 'c2', name: 'Acme Corp' }, { id: 'c3', name: 'INTERNAL' }, { id: 'c4', name: 'Internal Audit' }])
  assert(ids.size === 2 && ids.has('c1') && ids.has('c3'), 'the Internal client is found by name (trimmed, any case) — "Internal Audit" is a different client')
  // The Internal side applies to every role.
  const internalOnly = [...batch('w', 4, 4, { client_id: 'c-internal' })]
  for (const role of types.KPI_ROLES) {
    const g = kpi.computeRoleGoal(role, 'w', internalOnly, MONTH, INTERNAL)
    assert(g.buckets.find((b) => b.key === 'recurring')!.planned === 4 && g.buckets.find((b) => b.key === 'planned')!.planned === 0, `${role}: Internal-client tasks sit on the recurring side`)
  }

  // ---------------------------------------------------------------- 5. what counts as "due this month" and "done"
  console.log('\n--- 5. due this month / done by month end ---')
  const one = (over: Partial<Task>) => kpi.computeRoleGoal('project', 'w', [task({ worker_id: 'w', ...over })], MONTH, INTERNAL)
  assert(one({ due_date: day(10) }).planned === 1, 'a task due in the month is planned')
  assert(one({ due_date: '2026-06-02' }).planned === 0 && one({ due_date: '2026-04-28' }).planned === 0, 'tasks due in other months are not')
  assert(one({ due_date: null }).planned === 0, 'a legacy card with no due date belongs to no month')
  assert(one({ due_date: '2026-06-10', original_due_date: day(20) }).planned === 1, 'a deadline pushed out of the month still counts in the month it was first due (original due date wins)')
  assert(kpi.computeRoleGoal('project', 'w', [task({ worker_id: 'w', due_date: '2026-06-10', original_due_date: day(20) })], '2026-06', INTERNAL).planned === 0, '…and not in the month it was pushed to')
  assert(one({ due_date: day(10), status: 'recurring', repeats: 'weekly' }).planned === 0, 'a template on the Recurring shelf is not work, so it is not planned')
  assert(one({ due_date: day(10), ...finished(day(9)) }).done === 1, 'completed before its due date → done')
  assert(one({ due_date: day(10), status: 'completed', completed_at: '2026-06-02T09:00:00.000Z' }).done === 0, 'completed after the month ended → not done for that month')
  assert(one({ due_date: day(10), status: 'completed', completed_at: '2026-04-30T09:00:00.000Z' }).done === 1, 'finished early, in an earlier month, is done')
  assert(one({ due_date: day(10), status: 'completed', completed_at: null }).done === 1, 'a completed card without a timestamp counts as done')
  for (const status of ['todo', 'in_progress', 'waiting', 'for_review', 'rework'] as const) {
    assert(one({ due_date: day(10), status }).done === 0, `a card still in ${status} is not done`)
  }
  assert(one({ due_date: day(10), ...finished(day(9)), archived_at: `${MONTH}-28T00:00:00.000Z` }).done === 1, 'an archived completed card still counts as done (archiving never lowers the goal)')
  assert(kpi.computeRoleGoal('project', 'w', [task({ worker_id: 'someone-else', due_date: day(10) })], MONTH, INTERNAL).planned === 0, "other people's tasks are never counted")

  // ---------------------------------------------------------------- 6. a side with nothing due
  console.log('\n--- 6. empty sides ---')
  const onlyPlanned = kpi.computeRoleGoal('maintenance_outreach', 'w', batch('w', 10, 8), MONTH, INTERNAL)
  assert(onlyPlanned.pct === 80, 'no maintenance tasks due → the outreach side carries the whole goal (80%)')
  assert(onlyPlanned.buckets.find((b) => b.key === 'planned')!.effectiveWeight === 1 && onlyPlanned.buckets.find((b) => b.key === 'recurring')!.effectiveWeight === 0, '…with its weight renormalised to 100%')
  assert(onlyPlanned.buckets.find((b) => b.key === 'recurring')!.pct === null, '…and the empty side shown as "none due", not 0% or 100%')
  const onlyRecurring = kpi.computeRoleGoal('social_media', 'w', batch('w', 4, 3, weekly(1)), MONTH, INTERNAL)
  assert(onlyRecurring.pct === 75, 'only recurring work due → that side is the whole goal (75%)')
  const nothing = compute(worker('w', 'project'), [])
  assert(nothing.goalAchievement === null && nothing.scoreParts.goal === null && nothing.goalMode === 'role', 'nothing due at all → no goal (—), not a fake 0')
  const noGoalScore = compute(worker('w', 'project'), [task({ worker_id: 'w', due_date: '2026-04-30', ...finished(day(2)) })])
  assert(noGoalScore.scoreParts.goal === null, 'a completion that was due in another month adds nothing to this month’s goal')

  // ---------------------------------------------------------------- 7. no KPI role: today's way
  console.log('\n--- 7. no KPI role keeps the Tasks plan ---')
  const planGoal = (target: number | null): MonthlyGoal => ({
    id: 'g', worker_id: 'w', month: MONTH, target, on_time_target: 90, qa_target: 90, note: null, created_at: '', updated_at: '',
  })
  const fiveDone = batch('w', 5, 5)
  const withPlan = compute(worker('w', null), fiveDone, planGoal(10))
  assert(withPlan.goalMode === 'target' && withPlan.goalAchievement === 0.5 && withPlan.scoreParts.goal === 50, '5 completed ÷ a plan of 10 = 50%')
  assert(withPlan.goalTarget === 10 && withPlan.goalAchieved === 5, 'the plan and completions are reported as before')
  const beaten = compute(worker('w', null), batch('w', 12, 12), planGoal(10))
  assert(beaten.goalAchievement === 1.2 && beaten.scoreParts.goal === 100, 'beating the plan shows 120% progress but scores 100')
  const noPlan = compute(worker('w', null), fiveDone, null)
  assert(noPlan.goalMode === 'none' && noPlan.scoreParts.goal === null && noPlan.goalTarget === null, 'no plan typed in → no goal, and the score is on-time + QA only')
  assert(noPlan.score === 100, 'on-time 100 + QA 100 → 100 without a goal')
  const roleIgnoresPlan = compute(worker('w', 'project'), batch('w', 10, 9), planGoal(1))
  assert(roleIgnoresPlan.goalMode === 'role' && roleIgnoresPlan.scoreParts.goal === 90, 'a person with a KPI role ignores the typed Tasks plan')

  // ---------------------------------------------------------------- 8. rework is measured but not scored
  console.log('\n--- 8. rework is no longer part of the score ---')
  const reworked = batch('w', 10, 10).map((t, i) => (i < 4 ? { ...t, rework_required: true, rework_type: 'incorrect_work' as const } : t))
  const clean = batch('w', 10, 10)
  const a = compute(worker('w', 'project'), reworked)
  const b = compute(worker('w', 'project'), clean)
  assert(a.reworkRatePct === 40 && b.reworkRatePct === 0, 'the rework rate is still measured (40% vs 0%)')
  assert(a.score === b.score, `…but it does not move the score (${a.score} vs ${b.score})`)
  assert(JSON.stringify(Object.keys(a.scoreParts).sort()) === JSON.stringify(['goal', 'onTime', 'qa']), 'the score is made of exactly on-time, QA and goal')
  const team = kpi.computeTeamKpi([a, b])
  assert(team.reworkRatePct === 20, 'the team rework rate still aggregates (20%)')

  // ---------------------------------------------------------------- 9. Needs Attention wording
  console.log('\n--- 9. behind-pace alert ---')
  const nowMidMonth = new Date(2026, 4, 20) // Wed 20 May: 14 of 21 weekdays gone
  const stalled = compute(worker('rolewk', 'maintenance_outreach'), batch('rolewk', 10, 0), null, nowMidMonth)
  const stalledPlan = compute(worker('planwk', null), batch('planwk', 10, 0), planGoal(10), nowMidMonth)
  const items = kpi.buildAttention([stalled, stalledPlan], [], MONTH, nowMidMonth)
  const roleItem = items.find((i) => i.worker.id === 'rolewk' && i.drill.kind === 'goal')
  const planItem = items.find((i) => i.worker.id === 'planwk' && i.drill.kind === 'goal')
  assert(!!roleItem && /of this month's tasks done/.test(roleItem.message), `a role-goal employee behind pace is told "…of this month's tasks done" (${roleItem?.message})`)
  assert(!!planItem && /of target/.test(planItem.message), 'a Tasks-plan employee keeps the "of target" wording')

  // ---------------------------------------------------------------- 10. the demo-mode backend
  console.log('\n--- 10. demo backend: KPI roles on workers ---')
  const { localBackend, normalizeWorker } = await import('../src/lib/localDb')
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in (auto-seeds the demo team)')
  const workers = (await localBackend.listWorkers()).data!
  const by = (e: string) => workers.find((w) => w.email === e)!
  assert(by('jasper@example.com').kpi_role === 'project' && by('matthew@example.com').kpi_role === 'project', 'seed: Jasper & Matthew → client & project work')
  assert(by('jea@example.com').kpi_role === 'maintenance_outreach' && by('april@example.com').kpi_role === 'maintenance_outreach', 'seed: Jea & April Joy → maintenance & outreach')
  assert(by('mary@example.com').kpi_role === 'social_media', 'seed: Mary → social media & content')
  assert(by('john@example.com').kpi_role === null && by('sarah@example.com').kpi_role === null, 'seed: everyone else has no KPI role')

  const created = await localBackend.createWorker({ name: 'Role Test', hourly_rate: 10, accountEmail: 'role.test@example.com', accountPassword: 'secret1', kpi_role: 'social_media' })
  assert(!created.error && created.data?.kpi_role === 'social_media', 'createWorker stores the KPI role')
  const junk = await localBackend.createWorker({ name: 'Junk Role', hourly_rate: 10, accountEmail: 'junk.role@example.com', accountPassword: 'secret1', kpi_role: 'wizard' as unknown as KpiRole })
  assert(!junk.error && junk.data?.kpi_role === null, 'an unknown role is stored as "no role"')
  const plainCreate = await localBackend.createWorker({ name: 'No Role', hourly_rate: 10, accountEmail: 'no.role@example.com', accountPassword: 'secret1' })
  assert(!plainCreate.error && plainCreate.data?.kpi_role === null, 'a worker created without a role has none')
  const changed = await localBackend.updateWorker(created.data!.id, { kpi_role: 'project' })
  assert(!changed.error && changed.data?.kpi_role === 'project', 'updateWorker changes the role')
  const untouched = await localBackend.updateWorker(created.data!.id, { hourly_rate: 11 })
  assert(!untouched.error && untouched.data?.kpi_role === 'project', 'an edit that does not mention the role leaves it alone')
  const cleared = await localBackend.updateWorker(created.data!.id, { kpi_role: null })
  assert(!cleared.error && cleared.data?.kpi_role === null, 'the role can be cleared')
  const bad = await localBackend.updateWorker(created.data!.id, { kpi_role: 'nonsense' as unknown as KpiRole })
  assert(!bad.error && bad.data?.kpi_role === null, 'an unknown role on update becomes "no role"')
  assert(normalizeWorker({ id: 'legacy', name: 'Legacy' } as Worker).kpi_role === null, 'a stored worker row from before KPI roles loads with no role')
  assert(types.normalizeWorker({ id: 'legacy2', name: 'Legacy 2' }).kpi_role === null, 'the shared normalizer agrees')
  // A demo workspace saved before KPI roles existed: the sample team picks the roles up,
  // but only while the key is absent — a role that was set or cleared explicitly is final.
  const legacyDemo = (email: string, extra: Record<string, unknown> = {}) => normalizeWorker({ id: 'l', name: 'L', email, ...extra } as unknown as Worker).kpi_role
  assert(legacyDemo('jasper@example.com') === 'project' && legacyDemo('Matthew@Example.com') === 'project', 'an old demo workspace: Jasper & Matthew load as client & project work')
  assert(legacyDemo('jea@example.com') === 'maintenance_outreach' && legacyDemo('april@example.com') === 'maintenance_outreach', '…Jea & April Joy as maintenance & outreach')
  assert(legacyDemo('mary@example.com') === 'social_media', '…and Mary as social media & content')
  assert(legacyDemo('john@example.com') === null && legacyDemo('someone@else.com') === null, '…while everyone else stays without a role')
  assert(legacyDemo('jasper@example.com', { kpi_role: null }) === null, 'a role cleared on purpose (stored as null) is not filled back in')
  assert(legacyDemo('jasper@example.com', { kpi_role: 'social_media' }) === 'social_media', 'and a role someone chose is kept')

  // A plain worker can never set anyone's role — not even their own.
  await localBackend.signOut()
  const john = await localBackend.signIn('john@example.com', 'worker123')
  assert(!john.error && john.data?.role === 'worker', 'John (plain worker) signs in')
  const self = (await localBackend.listWorkers()).data!.find((w) => w.email === 'john@example.com')!
  const grab = await localBackend.updateWorker(self.id, { kpi_role: 'project' })
  assert(!!grab.error, 'a plain worker cannot change a KPI role (workers.manage is needed)')
  await localBackend.signOut()
  await localBackend.signIn('admin', 'admin.pipelinesync')
  assert((await localBackend.listWorkers()).data!.find((w) => w.id === self.id)!.kpi_role === null, '…and it stayed empty')

  // ---------------------------------------------------------------- 11. the seeded team end to end
  console.log('\n--- 11. the seeded team ---')
  const seededWorkers = (await localBackend.listWorkers()).data!
  const allTasks = (await localBackend.listTasks()).data!
  const clients = (await localBackend.listClients()).data!
  const seededInternal = kpi.internalClientIdsOf(clients)
  assert(seededInternal.size === 1, 'the demo workspace has one Internal client')
  const month = kpi.currentMonthKey()
  const goals = (await localBackend.listMonthlyGoals()).data!
  for (const email of ['jasper@example.com', 'matthew@example.com', 'jea@example.com', 'april@example.com', 'mary@example.com']) {
    const w = seededWorkers.find((x) => x.email === email)!
    const row = kpi.computeEmployeeKpi({
      worker: w, tasks: allTasks, month, internalClientIds: seededInternal,
      goal: goals.find((g) => g.worker_id === w.id && g.month === month) ?? null,
    })
    const both = row.goalBuckets.length === 2 && row.goalBuckets.every((bk) => bk.pct === null || (bk.pct >= 0 && bk.pct <= 100))
    assert(row.goalMode === 'role' && both, `${w.name}: a role-based goal with two sides (${row.goalBuckets.map((bk) => `${bk.label} ${bk.pct ?? '—'}%`).join(', ')})`)
    assert(row.scoreParts.goal !== null && row.scoreParts.goal >= 0 && row.scoreParts.goal <= 100, `${w.name}: goal ${row.scoreParts.goal}% feeds a score of ${row.score}`)
    assert(row.score !== null && !('rework' in row.scoreParts), `${w.name}: the score has no rework part`)
  }
  const johnRow = kpi.computeEmployeeKpi({
    worker: seededWorkers.find((x) => x.email === 'john@example.com')!, tasks: allTasks, month, internalClientIds: seededInternal,
    goal: goals.find((g) => g.worker_id === seededWorkers.find((x) => x.email === 'john@example.com')!.id && g.month === month) ?? null,
  })
  assert(johnRow.goalMode === 'target', 'John (no role) keeps the Tasks-plan goal')

  if (failures) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nAll KPI goal checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
