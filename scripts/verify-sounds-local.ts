/**
 * Ad-hoc verification of the clock cues (sound) layer:
 *  - the four cues exist, are short, and are distinguishable from each other
 *  - the snapshot diff turns a change in the live timer list into the right cue
 *  - a client switch (a timer row being replaced) stays silent instead of
 *    reading as a clock-out plus a clock-in
 *  - locally-acted timers are excluded, so nobody hears their own click twice
 *  - a burst of team events collapses to one cue per kind
 *  - with no audio available (headless, or a webview that refuses a context)
 *    playing is a silent no-op rather than a crash — a cue must never be able
 *    to break a clock-in
 *  - the whole thing agrees with what the real backend actually returns
 *
 * Run: npx tsx scripts/verify-sounds-local.ts
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

const cues = (list: { cue: string }[]) => list.map((e) => e.cue).join(',')

async function main() {
  const { CUES, CUE_ORDER, cueDuration, playCue, readTeamSoundsPref, writeTeamSoundsPref, selectCues } = await import(
    '../src/lib/sounds'
  )
  const { diffTimerSnapshots, snapshotsEqual, timerSnapshots } = await import('../src/lib/teamSounds')
  const { localBackend } = await import('../src/lib/localDb')

  // ---- 1. the cue table ----------------------------------------------------
  const kinds = ['clock_in', 'clock_out', 'break_start', 'break_end'] as const
  assert(
    kinds.every((k) => !!CUES[k] && CUES[k].tones.length > 0),
    'all four clock events have a cue with at least one note'
  )
  assert(
    CUE_ORDER.length === 4 && kinds.every((k) => CUE_ORDER.includes(k)),
    'the play order covers exactly the four clock events'
  )
  assert(
    kinds.every((k) => cueDuration(k) > 0.1 && cueDuration(k) < 0.7),
    `every cue is a short blip, not a jingle (${kinds.map((k) => `${k}=${cueDuration(k).toFixed(2)}s`).join(' ')})`
  )
  assert(
    kinds.every((k) => CUES[k].tones.every((t) => t.gain === undefined || (t.gain > 0 && t.gain <= 1)) && CUES[k].level > 0 && CUES[k].level <= 1),
    'no cue is over unity, so the master gain cannot clip'
  )
  // Distinguishability: a rising shape, a falling shape, and a low pair are told
  // apart by their first and last pitch, not just by their labels.
  const signature = (k: (typeof kinds)[number]) => CUES[k].tones.map((t) => Math.round(t.freq)).join('-')
  const sigs = kinds.map(signature)
  assert(new Set(sigs).size === kinds.length, `the four cues sound different from each other (${sigs.join(' | ')})`)
  assert(
    CUES.clock_in.tones[CUES.clock_in.tones.length - 1].freq > CUES.clock_in.tones[0].freq,
    'clock-in rises (open)'
  )
  assert(CUES.clock_out.tones[CUES.clock_out.tones.length - 1].freq < CUES.clock_out.tones[0].freq, 'clock-out falls (closed)')
  assert(
    Math.max(...CUES.break_start.tones.map((t) => t.freq)) < Math.min(...CUES.clock_in.tones.map((t) => t.freq)),
    'a break sits clearly below the clock-in tones'
  )

  // ---- 2. no audio hardware / no AudioContext must be harmless -------------
  assert(playCue('clock_in') === false, 'with no AudioContext a cue is a silent no-op')
  assert(playCue('clock_in') === false, 'and asking twice in a row is still harmless')
  assert(selectCues(['clock_in', 'clock_in', 'break_end']).join(',') === 'clock_in,break_end', 'repeats collapse to one cue per kind')
  assert(selectCues([]).length === 0, 'no events, no sound')

  // ---- 3. the preference --------------------------------------------------
  assert(readTeamSoundsPref(null) === false, 'a signed-out visitor has no chime')
  assert(readTeamSoundsPref('u1') === false, 'the team chime is off until the admin asks for it')
  writeTeamSoundsPref('u1', true)
  assert(readTeamSoundsPref('u1') === true, 'the admin can switch it on')
  assert(readTeamSoundsPref('u2') === false, 'another account on the same device is unaffected')
  writeTeamSoundsPref('u1', false)
  assert(readTeamSoundsPref('u1') === false, 'and off again')

  // ---- 4. the diff ---------------------------------------------------------
  const running = (id: string, workerId = 'w1') => ({ id, worker_id: workerId, paused: false })
  const paused = (id: string, workerId = 'w1') => ({ id, worker_id: workerId, paused: true })

  assert(cues(diffTimerSnapshots([], [running('t1')])) === 'clock_in', 'a timer appearing is a clock-in')
  assert(cues(diffTimerSnapshots([running('t1')], [])) === 'clock_out', 'a timer disappearing is a clock-out')
  assert(cues(diffTimerSnapshots([running('t1')], [paused('t1')])) === 'break_start', 'paused going true is a break start')
  assert(cues(diffTimerSnapshots([paused('t1')], [running('t1')])) === 'break_end', 'paused going false is a break end')
  assert(diffTimerSnapshots([running('t1')], [running('t1')]).length === 0, 'an unchanged board is silent')
  assert(diffTimerSnapshots([], []).length === 0, 'an empty board is silent')
  assert(cues(diffTimerSnapshots([running('t1')], [running('t1'), running('t2', 'w2')])) === 'clock_in', 'a second worker appearing is their own clock-in')

  // A client switch: the backends close the timer and open a new one, so the
  // id changes while the person keeps working. That must not be announced.
  assert(diffTimerSnapshots([running('t1')], [running('t2')]).length === 0, 'a client switch (same worker, replaced row) is silent')
  assert(
    cues(diffTimerSnapshots([paused('t1')], [running('t2')])) === 'break_end',
    'a switch that also closes an open break reports the break ending, nothing else'
  )
  assert(
    cues(diffTimerSnapshots([running('t1')], [paused('t2')])) === 'break_start',
    'a switch that lands inside a break reports the break starting'
  )

  // Locally-acted timers are skipped, so the person who clicked is not chimed at twice.
  assert(diffTimerSnapshots([], [running('t2')], { ignoreTimerIds: ['t2'] }).length === 0, 'a timer this device just started is not announced back')
  assert(diffTimerSnapshots([running('t1')], [running('t2')], { ignoreTimerIds: ['t1', 't2'] }).length === 0, 'a switch this device made is quiet on both sides')
  assert(diffTimerSnapshots([running('t1')], [], { ignoreTimerIds: ['t1'] }).length === 0, 'a shift this device cancelled is not read as a clock-out')
  assert(
    diffTimerSnapshots([running('t1')], [paused('t1')], { ignoreTimerIds: ['t1'] }).length === 0,
    'a timer this device touched goes quiet entirely, break flips included'
  )

  // Watching a subset of the team.
  assert(
    cues(diffTimerSnapshots([], [running('t1', 'w1'), running('t2', 'w2')], { onlyWorkerIds: ['w2'] })) === 'clock_in',
    'a worker outside the watched set makes no noise'
  )

  // A burst from the whole team: every event is reported, but only one tone
  // per kind is played, so four simultaneous clock-ins are one chime.
  const arrivals = diffTimerSnapshots([], [running('a', 'w1'), running('b', 'w2'), running('c', 'w3'), running('d', 'w4')])
  assert(arrivals.length === 4, 'four workers arriving at once produce four events')
  assert(selectCues(arrivals.map((e) => e.cue)).length === 1, 'but one tone is played, not four')
  const mixed = diffTimerSnapshots(
    [running('a', 'w1'), paused('b', 'w2')],
    [paused('a', 'w1'), running('b', 'w2'), running('c', 'w3')]
  )
  assert(selectCues(mixed.map((e) => e.cue)).join(',') === 'clock_in,break_start,break_end', 'a mixed burst plays each kind once, in the fixed order')

  assert(snapshotsEqual([running('t1'), paused('t2', 'w2')], timerSnapshots([{ id: 't1', worker_id: 'w1', paused: false }, { id: 't2', worker_id: 'w2', paused: true }])), 'the snapshot helper agrees with snapshotsEqual')
  assert(!snapshotsEqual([running('t1')], [paused('t1')]), 'a break flip is not "equal"')
  assert(!snapshotsEqual([running('t1')], [running('t1'), running('t2', 'w2')]), 'an extra timer is not "equal"')
  assert(snapshotsEqual([running('t1'), running('t2', 'w2')], [running('t2', 'w2'), running('t1')]), 'a re-sorted identical list is "equal" (no double chime)')

  // ---- 5. against the real backend's rows ---------------------------------
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  const john = await localBackend.signIn('john@example.com', 'worker123')
  assert(!john.error && !!john.data?.workerId, 'john can sign in')

  const leftover = (await localBackend.listActiveTimers()).data || []
  for (const t of leftover) await localBackend.deleteTimer(t.id)

  // Every shift is booked to a client, so clock-in needs a real one.
  const clients = (await localBackend.listClients()).data || []
  assert(clients.length > 0, `demo mode has a client to clock in on (found ${clients.length})`)
  const started = await localBackend.startTimer({ worker_id: john.data!.workerId!, client_id: clients[0].id })
  assert(!started.error && !!started.data, 'john clocks in')
  const afterIn = timerSnapshots((await localBackend.listActiveTimers()).data || [])
  assert(cues(diffTimerSnapshots([], afterIn)) === 'clock_in', 'the real list read after a clock-in diffs to clock_in')

  const pausedRes = await localBackend.pauseTimer()
  assert(!pausedRes.error, 'john starts a break')
  const afterPause = timerSnapshots((await localBackend.listActiveTimers()).data || [])
  assert(cues(diffTimerSnapshots(afterIn, afterPause)) === 'break_start', 'the real list read after a break diffs to break_start')

  const resumed = await localBackend.resumeTimer()
  assert(!resumed.error, 'john resumes')
  const afterResume = timerSnapshots((await localBackend.listActiveTimers()).data || [])
  assert(cues(diffTimerSnapshots(afterPause, afterResume)) === 'break_end', 'the real list read after a resume diffs to break_end')

  const stopped = await localBackend.stopTimer(started.data!.id)
  assert(!stopped.error, 'john clocks out')
  const afterOut = timerSnapshots((await localBackend.listActiveTimers()).data || [])
  assert(cues(diffTimerSnapshots(afterResume, afterOut)) === 'clock_out', 'the real list read after a clock-out diffs to clock_out')
  assert(afterOut.length === 0, 'the board is empty again')
}

main()
  .then(() => {
    if (process.exitCode) console.log('\nFAILED')
    else console.log('\nAll sound checks passed.')
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
