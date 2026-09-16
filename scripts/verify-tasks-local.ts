/**
 * Verification of the Tasks board ordering rules (demo-mode local backend):
 * a NEW task lands at the very TOP of its column, and a task whose STAGE
 * (or assignee) changes lands at the top of the destination column — while
 * an explicit drag-drop position is still honoured.
 * Run: npx tsx scripts/verify-tasks-local.ts
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

import type { Task, TaskStatus } from '../src/lib/types'

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

async function main() {
  const { localBackend } = await import('../src/lib/localDb')

  // The exact order the board renders a column in: position first, then
  // newest-first as the tiebreaker (mirrors sortTasks / the Tasks page).
  const columnOrder = (rows: Task[], workerId: string, status: TaskStatus) =>
    rows
      .filter((t) => t.worker_id === workerId && t.status === status)
      .sort((a, b) => a.position - b.position || b.created_at.localeCompare(a.created_at))

  // 1) Admin signs in (auto-seeds the demo workspace) and picks an assignee
  //    and client for the test tasks.
  const admin = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!admin.error && admin.data?.role === 'admin', 'admin can sign in')
  const workers = await localBackend.listWorkers()
  const john = workers.data!.find((w) => w.email === 'john@example.com')!
  const sarah = workers.data!.find((w) => w.email === 'sarah@example.com')!
  const clients = await localBackend.listClients()
  const client = clients.data!.find((c) => c.status === 'active')!

  // 2) Two tasks created one after another: the SECOND must be on top.
  const a = await localBackend.createTask({ worker_id: john.id, client_id: client.id, title: 'VT-A created first', status: 'todo' })
  const b = await localBackend.createTask({ worker_id: john.id, client_id: client.id, title: 'VT-B created second', status: 'todo' })
  assert(!a.error && !b.error, 'both test tasks created')
  let todo = columnOrder((await localBackend.listTasks()).data!, john.id, 'todo')
  assert(todo[0]?.title === 'VT-B created second', 'newest task sits at the very TOP of the column (not the bottom)')
  assert(todo[1]?.title === 'VT-A created first', 'the older of the two sits right below it')
  assert(b.data!.position === 0, 'new task is created at position 0')
  assert(todo.every((t, i) => t.position === i), `column positions stay gap-free (got: ${todo.map((t) => t.position).join(',')})`)

  // 3) Stage change through updateTask (the edit-dialog path): lands on TOP
  //    of the destination column, above everything already there.
  const moved = await localBackend.updateTask(a.data!.id, { status: 'in_progress' })
  assert(!moved.error, 'stage change saved')
  assert(moved.data!.position === 0, 'moved task takes position 0 in the new stage')
  const prog = columnOrder((await localBackend.listTasks()).data!, john.id, 'in_progress')
  assert(prog[0]?.id === a.data!.id, 'task that changed stage is at the TOP of the new column')
  assert(prog.every((t, i) => t.position === i), 'destination column stays gap-free')

  // 4) Assignee change (admin hands the card to another worker): TOP of the
  //    new worker's column there too.
  const reassigned = await localBackend.updateTask(b.data!.id, { worker_id: sarah.id })
  assert(!reassigned.error, 'assignee change saved')
  assert(reassigned.data!.position === 0, 'reassigned task takes position 0')
  const sarahTodo = columnOrder((await localBackend.listTasks()).data!, sarah.id, 'todo')
  assert(sarahTodo[0]?.id === b.data!.id, "reassigned task is at the TOP of the new worker's column")

  // 5) An explicit drag-drop position is still honoured (NOT forced to top).
  const c = await localBackend.createTask({ worker_id: john.id, client_id: client.id, title: 'VT-C', status: 'todo' })
  assert(!c.error, 'another task created')
  todo = columnOrder((await localBackend.listTasks()).data!, john.id, 'todo')
  const bottom = todo.length - 1
  const dropped = await localBackend.moveTask(c.data!.id, 'todo', bottom)
  assert(!dropped.error, 'explicit move saved')
  todo = columnOrder((await localBackend.listTasks()).data!, john.id, 'todo')
  assert(todo[bottom]?.id === c.data!.id, 'explicit drop index is honoured (card dropped at the bottom stays at the bottom)')

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
  if (failures) process.exitCode = 1
}

main()
