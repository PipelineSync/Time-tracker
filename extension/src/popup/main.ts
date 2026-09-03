/**
 * Popup controller.
 *
 * A tiny state machine rather than a framework: one `ClockState` from the API
 * layer, four views, and a 1-second tick that only re-paints the numbers. The
 * clock itself is never counted locally — every render recomputes the elapsed
 * time from the row in Supabase, so closing the popup, sleeping the laptop or
 * switching devices can never lose a shift.
 */

import '../styles/base.css'
import './popup.css'
import * as api from '../lib/api'
import type { ClockState, Snapshot } from '../lib/api'
import {
  computeEarnings,
  formatClockTime,
  formatDurationFromMs,
  formatMinutes,
  formatMsShort,
  money,
  timerBreakMs,
  timerElapsedMs,
} from '../lib/format'

type ViewName = 'setup' | 'login' | 'clock' | 'confirm'

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing element #${id}`)
  return node as T
}

const views: Record<ViewName, HTMLElement> = {
  setup: el('view-setup'),
  login: el('view-login'),
  clock: el('view-clock'),
  confirm: el('view-confirm'),
}

const banner = el('banner')
const toastEl = el('toast')
const brandTitle = el('brand-title')
const brandSub = el('brand-sub')
const signOutBtn = el<HTMLButtonElement>('btn-signout')

let state: ClockState = { kind: 'signed-out' }
let view: ViewName = 'login'
let busy = false
let toastTimer: number | undefined

// ---------------------------------------------------------------------------
// small view helpers
// ---------------------------------------------------------------------------

function showView(next: ViewName) {
  view = next
  for (const [name, node] of Object.entries(views)) node.hidden = name !== next
}

function showBanner(message: string | null, tone: 'error' | 'warn' | 'info' = 'error') {
  if (!message) {
    banner.hidden = true
    return
  }
  banner.hidden = false
  banner.textContent = message
  banner.dataset.tone = tone
}

function toast(message: string, tone: 'success' | 'error' = 'success') {
  toastEl.textContent = message
  toastEl.dataset.tone = tone
  toastEl.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true
  }, 3200)
}

function setBusy(next: boolean, label?: string) {
  busy = next
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button')) {
    btn.disabled = next && btn.id !== 'btn-signout' && btn.id !== 'btn-options'
  }
  if (label) brandSub.textContent = label
}

/** Disable double-submits without disabling the whole popup. */
async function run(action: () => Promise<void>, pendingLabel: string) {
  if (busy) return
  showBanner(null)
  setBusy(true, pendingLabel)
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Something went wrong.'
    showBanner(message)
  } finally {
    setBusy(false)
    await refresh()
  }
}

function snapshot(): Snapshot | null {
  return state.kind === 'ready' ? state.snapshot : null
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render() {
  const snap = snapshot()

  if (state.kind === 'not-configured') {
    brandTitle.textContent = 'Work Tracker'
    brandSub.textContent = 'Not connected'
    signOutBtn.hidden = true
    el('footer-rate').textContent = ''
    showView('setup')
    return
  }

  if (state.kind === 'signed-out') {
    brandTitle.textContent = 'Work Tracker'
    brandSub.textContent = 'Sign in to clock in'
    signOutBtn.hidden = true
    el('footer-rate').textContent = ''
    showView('login')
    el<HTMLInputElement>('login-email').focus()
    return
  }

  // Signed in.
  signOutBtn.hidden = false
  brandTitle.textContent = snap!.businessName || 'Work Tracker'
  brandSub.textContent = snap!.worker.name
  el('footer-rate').textContent = `${money(snap!.worker.hourly_rate ?? 0, snap!.currency)}/hr`

  if (view !== 'confirm') showView('clock')
  renderTick()
}

/** Everything that changes every second (and depends only on the snapshot). */
function renderTick() {
  const snap = snapshot()
  if (!snap || view !== 'clock') return

  const now = new Date()
  const timer = snap.timer
  const pill = el('status-pill')
  const statusText = el('status-text')
  const timerEl = el('timer')
  const meta = el('timer-meta')
  const actionsIdle = el('actions-idle')
  const actionsRunning = el('actions-running')
  const breakBtn = el<HTMLButtonElement>('btn-break')

  if (!timer) {
    pill.dataset.state = 'out'
    statusText.textContent = 'Clocked out'
    timerEl.textContent = '00:00:00'
    timerEl.classList.add('idle')
    meta.textContent = 'Ready when you are.'
    actionsIdle.hidden = false
    actionsRunning.hidden = true
  } else {
    const elapsed = timerElapsedMs(timer, now)
    const breakMs = timerBreakMs(timer, now)

    timerEl.classList.remove('idle')
    timerEl.textContent = formatDurationFromMs(elapsed)
    actionsIdle.hidden = true
    actionsRunning.hidden = false

    if (timer.paused) {
      pill.dataset.state = 'break'
      statusText.textContent = 'On break'
      meta.textContent = `Clocked in ${formatClockTime(timer.start_time)} · break ${formatMsShort(breakMs)}`
      breakBtn.textContent = 'End break'
      if (!busy) breakBtn.disabled = false
    } else {
      pill.dataset.state = 'working'
      statusText.textContent = 'Working'
      meta.textContent = `Clocked in ${formatClockTime(timer.start_time)}${
        breakMs > 0 ? ` · ${formatMsShort(breakMs)} on break` : ''
      }`
      breakBtn.textContent = 'Start break'
    }
  }

  // Today = entries already saved + the shift currently running.
  const liveMinutes = timer ? timerElapsedMs(timer, now) / 60000 : 0
  const totalMinutes = snap.todayMinutes + liveMinutes
  const totalEarnings = snap.todayEarnings + (timer ? computeEarnings(liveMinutes, timer.hourly_rate ?? 0) : 0)
  el('today-time').textContent = formatMinutes(totalMinutes)
  el('today-money').textContent = money(totalEarnings, snap.currency)
}

async function refresh() {
  try {
    state = await api.loadState()
    showBanner(null)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load your status.'
    // A dropped request must never bounce a clocked-in worker back to the
    // login form: keep the last known state on screen and just say why.
    if (state.kind === 'ready') showBanner(`${message} Showing your last known status.`)
    else showBanner(message)
  }
  render()
}

// ---------------------------------------------------------------------------
// clock-out confirmation
// ---------------------------------------------------------------------------

function openConfirm() {
  const snap = snapshot()
  const timer = snap?.timer
  if (!timer) return

  const now = new Date()
  const workedMs = timerElapsedMs(timer, now)
  const breakMs = timerBreakMs(timer, now)
  const minutes = Math.round(workedMs / 60000)
  const rate = timer.hourly_rate ?? 0

  el('confirm-summary').innerHTML = ''
  const rows: [string, string][] = [
    ['Worked', formatMinutes(minutes)],
    ['Breaks', formatMsShort(breakMs)],
    ['Started', formatClockTime(timer.start_time)],
    ['Earned', money(computeEarnings(minutes, rate), snap!.currency)],
  ]
  if (timer.project) rows.splice(2, 0, ['Project', timer.project])

  for (const [label, value] of rows) {
    const row = document.createElement('div')
    const key = document.createElement('span')
    key.textContent = label
    const val = document.createElement('span')
    val.textContent = value
    row.append(key, val)
    el('confirm-summary').append(row)
  }

  render() // repaint header, then switch view
  showView('confirm')
  el<HTMLTextAreaElement>('confirm-note').focus()
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

el('btn-open-options').addEventListener('click', () => chrome.runtime.openOptionsPage())
el('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage())

el('login-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const email = el<HTMLInputElement>('login-email').value
  const password = el<HTMLInputElement>('login-password').value
  void run(async () => {
    await api.signIn(email, password)
    el<HTMLInputElement>('login-password').value = ''
  }, 'Signing in…')
})

signOutBtn.addEventListener('click', () => {
  void run(async () => {
    await api.signOut()
    toast('Signed out')
  }, 'Signing out…')
})

/** Show or hide the optional project/note fields on the clock-in screen. */
function toggleDetails(open: boolean) {
  const details = el('clockin-details')
  const btn = el<HTMLButtonElement>('btn-toggle-details')
  details.hidden = !open
  btn.setAttribute('aria-expanded', String(open))
  btn.querySelector('.chev')!.textContent = open ? '▴' : '▾'
}

el<HTMLButtonElement>('btn-toggle-details').addEventListener('click', () => {
  toggleDetails(el('clockin-details').hidden)
  if (!el('clockin-details').hidden) el<HTMLInputElement>('clockin-project').focus()
})

el<HTMLButtonElement>('btn-clock-in').addEventListener('click', () => {
  const project = el<HTMLInputElement>('clockin-project').value
  const notes = el<HTMLTextAreaElement>('clockin-notes').value
  void run(async () => {
    const timer = await api.clockIn({ project, notes })
    el<HTMLInputElement>('clockin-project').value = ''
    el<HTMLTextAreaElement>('clockin-notes').value = ''
    el('clockin-details').hidden = true
    toggleDetails(false)
    const resumed = Date.now() - new Date(timer.start_time).getTime() > 2 * 60 * 1000
    toast(resumed ? 'Picked up your open timer' : `Clocked in${timer.project ? ` — ${timer.project}` : ''}`)
  }, 'Clocking in…')
})

el<HTMLButtonElement>('btn-break').addEventListener('click', () => {
  const snap = snapshot()
  const onBreak = Boolean(snap?.timer?.paused)
  void run(async () => {
    if (onBreak) {
      await api.endBreak()
      toast('Back to work')
    } else {
      await api.startBreak()
      toast('On break — timer paused')
    }
  }, onBreak ? 'Ending break…' : 'Starting break…')
})

el<HTMLButtonElement>('btn-clock-out').addEventListener('click', () => {
  openConfirm()
})

el<HTMLButtonElement>('btn-confirm-cancel').addEventListener('click', () => {
  showView('clock')
  renderTick()
})

el<HTMLButtonElement>('btn-confirm-clockout').addEventListener('click', () => {
  const note = el<HTMLTextAreaElement>('confirm-note').value
  void run(async () => {
    const { entry } = await api.clockOut(note)
    el<HTMLTextAreaElement>('confirm-note').value = ''
    showView('clock')
    toast(`Clocked out — ${formatMinutes(entry.total_minutes)}${note.trim() ? ' · note saved' : ''}`)
  }, 'Clocking out…')
})

// Escape backs out of the clock-out confirmation. (Enter is left alone: the
// note field is a textarea, where Enter should start a new line.)
document.addEventListener('keydown', (event) => {
  if (view !== 'confirm') return
  if (event.key === 'Escape') {
    showView('clock')
    renderTick()
  }
})

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

window.setInterval(() => {
  if (view === 'clock') renderTick()
}, 1000)

void refresh()
