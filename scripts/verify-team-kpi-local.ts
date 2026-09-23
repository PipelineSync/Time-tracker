/**
 * Verification of the Team KPI feature (demo-mode local backend):
 *  - the seeded team (Jasper, Matthew, Jea, April, Mary) with their real
 *    workweeks (Mon–Fri vs Tue–Sat, all 40h)
 *  - new tasks REQUIRE a due date; stage moves stamp the KPI timestamps and
 *    append stage history; QA scoring + due-date changes write audit rows
 *  - schedule-aware workload lands each seeded member on their target band
 *  - the KPI engine produces scores/on-time/goals from tasks alone (nothing
 *    is entered twice), Needs Attention + review backlog fire their rules
 *  - management inputs are gated: goals need `team_kpi.view`, bonus decisions
 *    are Owner-only, and ungranted workers read empty lists
 *
 * Run: npx tsx scripts/verify-team-kpi-local.ts
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

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

async function main() {
  const { localBackend } = await import('../src/lib/localDb')
  const kpi = await import('../src/lib/kpi')

  // ---- 1. sign in (auto-seeds the demo workspace) ----
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')

  // ---- 2. the seeded team + schedules ----
  const workers = (await localBackend.listWorkers()).data!
  const byEmail = (e: string) => workers.find((w) => w.email === e)!
  const jasper = byEmail('jasper@example.com')
  const matthew = byEmail('matthew@example.com')
  const jea = byEmail('jea@example.com')
  const april = byEmail('april@example.com')
  const mary = byEmail('mary@example.com')
  assert(!!jasper && !!matthew && !!jea && !!april && !!mary, 'the 5 team members are seeded')
  assert(
    JSON.stringify(jasper.workdays) === '[1,2,3,4,5]' &&
      JSON.stringify(mary.workdays) === '[1,2,3,4,5]' &&
      jasper.weekly_capacity_hours === 40 && mary.weekly_capacity_hours === 40,
    'Jasper & Mary work Mon–Fri at 40h',
  )
  assert(
    JSON.stringify(matthew.workdays) === '[2,3,4,5,6]' &&
      JSON.stringify(jea.workdays) === '[2,3,4,5,6]' &&
      JSON.stringify(april.workdays) === '[2,3,4,5,6]' &&
      matthew.weekly_capacity_hours === 40 &&
      jea.weekly_capacity_hours === 40 &&
      april.weekly_capacity_hours === 40,
    'Matthew, Jea & April work Tue–Sat at 40h',
  )

  // ---- 3. management inputs are seeded ----
  const month = kpi.currentMonthKey()
  const goals = (await localBackend.listMonthlyGoals()).data!
  const bonuses = (await localBackend.listBonusDecisions()).data!
  assert(goals.some((g) => g.worker_id === jasper.id && g.month === month), 'a current-month goal row is seeded for Jasper')
  assert(
    goals.find((g) => g.worker_id === mary.id && g.month === month)?.on_time_target === 95,
    "Mary's role uses a 95% on-time target",
  )
  assert(bonuses.length > 0, 'bonus decisions are seeded (manual, not computed)')

  // ---- 4. due date is required for NEW tasks ----
  const client = (await localBackend.listClients()).data!.find((c) => c.status === 'active')!
  const noDue = await localBackend.createTask({
    worker_id: jasper.id, client_id: client.id, title: 'No due date', status: 'todo',
  })
  assert(!!noDue.error && /due date/i.test(noDue.error!), 'a new task without a due date is refused')

  const created = (await localBackend.createTask({
    worker_id: jasper.id, client_id: client.id, title: 'KPI verify task', status: 'todo',
    due_date: '2099-12-31', estimated_hours: 3,
  })).data!
  assert(!!created && created.due_date === '2099-12-31' && created.estimated_hours === 3, 'a dated task with an estimate is created')
  assert(created.stage_history.length >= 1, 'a created task carries its stage history')

  // ---- 5. stage timestamps on a move into For Review ----
  const moved = (await localBackend.moveTask(created.id, 'for_review', 0)).data!
  assert(moved.status === 'for_review', 'the task moved to For Review')
  assert(!!moved.submitted_for_review_at, 'Submitted for Review At was stamped')
  assert(moved.stage_history.length >= 2, 'the stage history grew on the move')

  // ---- 6. QA scoring completes the task and writes an audit row ----
  const reviewed = (await localBackend.updateTask(created.id, {
    qa_score: 4, rework_required: false, status: 'completed',
  })).data!
  assert(reviewed.status === 'completed' && reviewed.qa_score === 4, 'the QA score is stored on completion')
  assert(!!reviewed.qa_reviewed_at && !!reviewed.qa_reviewed_by, 'the QA reviewer and timestamp are stamped')
  const audit = (await localBackend.listKpiAudit()).data!
  assert(audit.some((a) => a.action === 'qa_scored'), 'a qa_scored audit row was appended')
  assert(audit.some((a) => a.action === 'completed' || a.detail?.includes('Completed') || a.action.includes('complet')), 'a completion audit row exists')

  // ---- 7. due-date changes: audit always; original survives a missed push ----
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const dueEditTask = (await localBackend.createTask({
    worker_id: jasper.id, client_id: client.id, title: 'Due-edit task', status: 'todo',
    due_date: yesterday,
  })).data!
  const dueEdited = (await localBackend.updateTask(dueEditTask.id, { due_date: tomorrow })).data!
  assert(dueEdited.original_due_date === yesterday, 'pushing a MISSED due date keeps the ORIGINAL deadline')
  const audit2 = (await localBackend.listKpiAudit()).data!
  const dueRows = audit2.filter((a) => a.action === 'due_date_changed')
  assert(dueRows.length >= 1, 'a due_date_changed audit row was appended')
  assert(
    dueRows.some((a) => a.detail?.includes(yesterday) && a.detail?.includes(tomorrow)),
    'the audit row preserves the original due date',
  )
  await localBackend.deleteTask(dueEditTask.id)

  // ---- 8. the KPI engine computes the month from tasks alone ----
  const allTasks = (await localBackend.listTasks()).data!
  const empKpi = kpi.computeEmployeeKpi({
    worker: jasper, tasks: allTasks, month,
    goal: goals.find((g) => g.worker_id === jasper.id && g.month === month) ?? null,
  })
  assert(empKpi.completedCount > 0, 'the seed gives Jasper completed work this month')
  assert(empKpi.score !== null && empKpi.score >= 0 && empKpi.score <= 100, `Jasper's weighted KPI score computes (${empKpi.score})`)
  assert(empKpi.onTimePct !== null, `Jasper's on-time % computes (${empKpi.onTimePct})`)

  const weights = kpi.KPI_WEIGHTS
  const weightSum = weights.onTime + weights.qa + weights.goal + weights.rework
  assert(Math.abs(weightSum - 1) < 1e-9, 'the KPI weights sum to 100% (30/30/25/15)')
  assert(weights.onTime === 0.3 && weights.qa === 0.3 && weights.goal === 0.25 && weights.rework === 0.15, 'the weights match the spec')

  // ---- 9. schedule-aware workload lands on the seeded targets ----
  const band = (label: string, worker: typeof jasper, target: number) => {
    const wl = kpi.computeWorkload(worker, allTasks, month)
    assert(
      wl.pct !== null && Math.abs(wl.pct - target) <= 8,
      `${label}'s workload is on target (got ${wl.pct}%, target ~${target}%)`,
    )
    return wl
  }
  const wlJasper = band('Jasper', jasper, 82)
  band('Matthew', matthew, 54)
  band('Jea', jea, 72)
  band('April', april, 48)
  const wlMary = band('Mary', mary, 96)
  assert(wlJasper.level === 'high', 'Jasper (82%) reads as High workload')
  assert(kpi.workloadLevel(50) === 'available' && kpi.workloadLevel(70) === 'normal' &&
    kpi.workloadLevel(90) === 'high' && kpi.workloadLevel(110) === 'overloaded',
    'workload bands: <60 Available, 60–80 Normal, 81–100 High, >100 Overloaded')
  assert(wlMary.availableHours > 0, "Mary's available hours respect her own workweek")

  // ---- 10. Needs Attention + review backlog ----
  const employees = [jasper, matthew, jea, april, mary].map((w) =>
    kpi.computeEmployeeKpi({
      worker: w, tasks: allTasks, month,
      goal: goals.find((g) => g.worker_id === w.id && g.month === month) ?? null,
    }),
  )
  const attention = kpi.buildAttention(employees, allTasks, month)
  assert(attention.some((a) => a.worker.id === mary.id && a.severity === 'critical' && /overdue/i.test(a.message)),
    "Mary's high-priority overdue task raises a critical alert")
  assert(attention.some((a) => a.worker.id === april.id && a.drill.kind === 'available'),
    "April's low workload suggests 'available for more work'")
  const backlog = kpi.buildReviewBacklog(allTasks)
  assert(backlog.count >= 1, `the seeded review backlog has ${backlog.count} task(s) awaiting review`)
  assert(backlog.oldestDays !== null && backlog.oldestDays >= 0, 'the oldest review age computes')

  // ---- 11. legacy no-due tasks are excluded from on-time ----
  const legacy = allTasks.find((t) => !t.due_date)!
  assert(!!legacy && kpi.wasOnTime(legacy) === null, 'a legacy task with no due date is excluded from on-time KPI')

  // ---- 12. rework classification: only employee-caused counts ----
  const mod = await import('../src/lib/types')
  assert(mod.isEmployeeCausedRework('incorrect_work') === true, 'incorrect work counts against the employee')
  assert(mod.isEmployeeCausedRework('scope_changed') === false, 'a client scope change does NOT count against the employee')
  assert(mod.isEmployeeCausedRework('access_issue') === false, 'an access/system issue does NOT count against the employee')

  // ---- 13. gates: goals need team_kpi.view; bonuses are Owner-only ----
  const savedGoal = await localBackend.saveMonthlyGoal({
    worker_id: jasper.id, month, target: 15, on_time_target: 90, qa_target: 90, note: null,
  })
  assert(!savedGoal.error && savedGoal.data?.target === 15, 'the admin can save monthly targets')
  const savedBonus = await localBackend.saveBonusDecision({
    worker_id: matthew.id, month, eligible: 'yes', approved_amount: 100, note: null,
  })
  assert(!savedBonus.error && savedBonus.data?.approved_amount === 100, 'the Owner can approve a bonus manually')
  const bonusAudit = (await localBackend.listKpiAudit()).data!
  assert(bonusAudit.some((a) => a.action === 'bonus_decided'), 'the bonus approval wrote an audit row')

  // A plain worker: no team_kpi read, no goal write, no bonus write.
  const john = await localBackend.signIn('john@example.com', 'worker123')
  assert(!john.error, 'a plain worker can sign in')
  const johnGoals = await localBackend.listMonthlyGoals()
  assert(!johnGoals.error && (johnGoals.data ?? []).length === 0, 'a worker without team_kpi.view reads no goals')
  const johnBonus = await localBackend.saveBonusDecision({
    worker_id: john.data!.workerId!, month, eligible: 'yes', approved_amount: 999, note: null,
  })
  assert(!!johnBonus.error && /Owner/i.test(johnBonus.error!), 'bonus approval is refused to non-Owners')
  const johnGoalWrite = await localBackend.saveMonthlyGoal({
    worker_id: john.data!.workerId!, month, target: 3, on_time_target: 90, qa_target: 90, note: null,
  })
  assert(!!johnGoalWrite.error, 'saving targets is refused to a worker without the grant')

  // ---- 14. team aggregates from the employee rows ----
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const team = kpi.computeTeamKpi(employees)
  assert(team.score !== null && team.completedCount > 0, `the team KPI score aggregates (${team.score})`)
  assert(team.overdueCount >= 4, `Mary's overdue work shows in the team count (${team.overdueCount})`)
  assert(team.blockedCount >= 3, `blocked/waiting tasks aggregate (${team.blockedCount})`)

  // ---- 15. Requirement 1: KPI reviewers are not KPI subjects ----
  const baseWorkers = (await localBackend.listWorkers()).data!
  const baseTeamMembers = baseWorkers.filter((w) =>
    ['Jasper Maristela', 'Matthew Luzung', 'Jea Crizel Pineda', 'April Joy Manabat', 'Mary Gracelyn'].includes(w.name),
  )
  assert(
    baseTeamMembers.length === 5 && baseTeamMembers.every((w) => kpi.isKpiSubject(w)),
    'baseline all 5 team members are KPI subjects',
  )
  const defaultFilters: kpi.KpiFilters = { month, employee: 'all', client: 'all', status: 'all' }
  const baseEmployees = kpi.scopeEmployees(baseWorkers, defaultFilters)
  assert(baseEmployees.some((w) => w.name === jasper.name), 'Jasper is in baseline scopeEmployees')
  const baseEmpRows = baseEmployees.map((w) =>
    kpi.computeEmployeeKpi({
      worker: w,
      tasks: allTasks,
      month,
      goal: goals.find((g) => g.worker_id === w.id && g.month === month) ?? null,
    }),
  )
  const baseTeamScore = kpi.computeTeamKpi(baseEmpRows).score

  // Grant team_kpi.view to Jasper
  const jasperCurrent = baseWorkers.find((w) => w.name === jasper.name)!
  await localBackend.updateWorker(jasperCurrent.id, { permissions: ['team_kpi.view'] })
  const workersAfterGrant = (await localBackend.listWorkers()).data!
  const jasperGranted = workersAfterGrant.find((w) => w.id === jasperCurrent.id)!
  assert(!kpi.isKpiSubject(jasperGranted), 'Jasper with team_kpi.view is not a KPI subject')

  // scopeEmployees excludes him
  const employeesAfterGrant = kpi.scopeEmployees(workersAfterGrant, defaultFilters)
  assert(!employeesAfterGrant.some((w) => w.id === jasperCurrent.id), 'scopeEmployees excludes him')

  // team score recomputes without him
  const rowsAfterGrant = employeesAfterGrant.map((w) =>
    kpi.computeEmployeeKpi({
      worker: w,
      tasks: allTasks,
      month,
      goal: goals.find((g) => g.worker_id === w.id && g.month === month) ?? null,
    }),
  )
  const scoreAfterGrant = kpi.computeTeamKpi(rowsAfterGrant).score
  assert(scoreAfterGrant !== null && scoreAfterGrant !== baseTeamScore, `team score recomputes without him (${scoreAfterGrant} vs ${baseTeamScore})`)

  // employee filter omits him
  const filterOptions = workersAfterGrant.filter((w) => w.status === 'active' && kpi.isKpiSubject(w))
  assert(!filterOptions.some((w) => w.id === jasperCurrent.id), 'employee filter omits him')

  // Stale filter ID pointing at Jasper falls back to 'all'
  const staleScoped = kpi.scopeEmployees(workersAfterGrant, { ...defaultFilters, employee: jasperCurrent.id })
  assert(!staleScoped.some((w) => w.id === jasperCurrent.id) && staleScoped.length === employeesAfterGrant.length, 'stale filter id pointing at excluded worker falls back to all')

  // Excluded worker can still read goals and audit
  const jasperLogin = await localBackend.signIn('jasper@example.com', 'worker123')
  assert(!jasperLogin.error, 'excluded worker can sign in')
  const jasperGoals = await localBackend.listMonthlyGoals()
  assert(!jasperGoals.error && (jasperGoals.data ?? []).length > 0, 'excluded worker can still read goals')
  const jasperAudit = await localBackend.listKpiAudit()
  assert(!jasperAudit.error && (jasperAudit.data ?? []).length > 0, 'excluded worker can still read audit')

  // Revoke team_kpi.view from Jasper
  await localBackend.signIn('admin', 'admin.pipelinesync')
  await localBackend.updateWorker(jasperCurrent.id, { permissions: [] })
  const workersAfterRevoke = (await localBackend.listWorkers()).data!
  const jasperRevoked = workersAfterRevoke.find((w) => w.id === jasperCurrent.id)!
  assert(kpi.isKpiSubject(jasperRevoked), 'Jasper is a KPI subject again after revoke')
  const employeesAfterRevoke = kpi.scopeEmployees(workersAfterRevoke, defaultFilters)
  assert(employeesAfterRevoke.some((w) => w.id === jasperCurrent.id), 'Jasper reappears in scopeEmployees after revoke')
  const filterOptionsAfterRevoke = workersAfterRevoke.filter((w) => w.status === 'active' && kpi.isKpiSubject(w))
  assert(filterOptionsAfterRevoke.some((w) => w.id === jasperCurrent.id), 'employee filter includes him again')

  // ---- 16. hours by client: estimates + logged time group per client ----
  const clients = (await localBackend.listClients()).data!
  const allEntries = (await localBackend.listEntries({ limit: 10000 })).data ?? []
  const hoursFilters: kpi.KpiFilters = { month, employee: 'all', client: 'all', status: 'all' }
  const hoursEmpIds = kpi.scopeEmployees(workersAfterRevoke, hoursFilters).map((w) => w.id)
  const clientRows = kpi.hoursByClient({
    tasks: kpi.applyKpiFilters(allTasks, hoursFilters),
    entries: allEntries,
    clients,
    employeeIds: hoursEmpIds,
  })
  const manualEst = allTasks
    .filter((t) => !t.archived_at)
    .reduce((s, t) => {
      const h = Number(t.estimated_hours)
      return s + (Number.isFinite(h) && h > 0 ? h : 0)
    }, 0)
  const gotEst = clientRows.reduce((s, r) => s + r.estimated, 0)
  assert(Math.abs(gotEst - manualEst) < 1e-6, `estimated hours by client match the manual task sum (${gotEst}h)`)
  const manualLogged =
    allEntries.filter((e) => hoursEmpIds.includes(e.worker_id)).reduce((s, e) => s + e.total_minutes, 0) / 60
  const gotLogged = clientRows.reduce((s, r) => s + r.actual, 0)
  assert(
    Math.abs(gotLogged - manualLogged) < 1e-6,
    `logged hours by client match the manual entry sum (${gotLogged.toFixed(1)}h)`,
  )
  const hourClient = clients.find((c) => c.status === 'active')!
  const scopedRows = kpi.hoursByClient({
    tasks: kpi.applyKpiFilters(allTasks, { month, employee: 'all', client: hourClient.id, status: 'all' }),
    entries: allEntries,
    clients,
    employeeIds: hoursEmpIds,
    clientFilter: hourClient.id,
  })
  assert(
    scopedRows.length > 0 && scopedRows.every((r) => r.clientId === hourClient.id),
    `the client filter restricts hours to ${hourClient.name}`,
  )
  assert(kpi.fmtHours(12.34) === '12.3h' && kpi.fmtHours(null) === '—', 'fmtHours formats for the UI')

  if (process.exitCode) {
    console.error('\nTeam KPI verification FAILED')
  } else {
    console.log('\nAll Team KPI checks passed.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
