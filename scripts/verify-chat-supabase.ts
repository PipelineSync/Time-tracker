/**
 * Verification of the Supabase-mode team chat. Runs the REAL
 * src/lib/supabaseDb.ts (rewritten in-memory to point at a mock Supabase client
 * that evaluates the same queries/RPCs the migration defines) and checks the
 * identity stamping, the member roster, and the "database not migrated yet"
 * fallbacks.
 *
 * Run: npx tsx scripts/verify-chat-supabase.ts
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { state, resetState } from './supabase-mock/mock-chat-supabase.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcFile = path.join(root, 'src', 'lib', 'supabaseDb.ts')
const tmpFile = path.join(root, 'src', 'lib', '__test_supabaseDb_tmp.ts')

let mod: typeof import('../src/lib/supabaseDb')
try {
  const source = readFileSync(srcFile, 'utf8')
    .replaceAll('import.meta.env', 'globalThis.__VITE_ENV__')
    .replaceAll(`from '@supabase/supabase-js'`, `from '../../scripts/supabase-mock/mock-chat-supabase.mjs'`)
  writeFileSync(tmpFile, source)
  globalThis.__VITE_ENV__ = {
    VITE_SUPABASE_URL: 'https://mock.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'mock-pub-key',
  }
  mod = await import('../src/lib/__test_supabaseDb_tmp')
} finally {
  rmSync(tmpFile, { force: true })
}
const { supabaseBackend } = mod

let failures = 0
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures += 1
    console.error(`FAIL: ${msg}`)
  } else {
    console.log(`ok: ${msg}`)
  }
}

const ADMIN = { id: 'user-admin', email: 'admin@x.com' }
const JOHN = { id: 'user-john', email: 'john@x.com' }
const SARAH = { id: 'user-sarah', email: 'sarah@x.com' }

function seedWorkspace() {
  resetState()
  state.workers = [
    { id: 'w-john', user_id: ADMIN.id, name: 'John Smith', position: 'Foreman', avatar_url: 'data:john', status: 'active' },
    { id: 'w-sarah', user_id: ADMIN.id, name: 'Sarah Johnson', position: null, avatar_url: null, status: 'inactive' },
  ]
  state.profiles = [
    { user_id: ADMIN.id, role: 'admin', worker_id: null },
    { user_id: JOHN.id, role: 'worker', worker_id: 'w-john' },
    { user_id: SARAH.id, role: 'worker', worker_id: 'w-sarah' },
  ]
  state.settings = [{ id: 's-1', user_id: ADMIN.id, business_name: 'Acme', currency: 'USD', timezone: 'UTC', avatar_url: 'data:admin' }]
  state.chat = [0, 1, 2, 3, 4].map((i) => ({
    id: `c${i}`,
    user_id: ADMIN.id,
    author_id: i % 2 ? JOHN.id : ADMIN.id,
    worker_id: i % 2 ? 'w-john' : null,
    author_name: i % 2 ? 'John Smith' : 'Admin',
    author_role: i % 2 ? 'worker' : 'admin',
    author_position: i % 2 ? 'Foreman' : 'Owner',
    author_avatar_url: i % 2 ? 'data:john' : 'data:admin',
    body: `message ${i}`,
    // Staggered so ordering is meaningful.
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }))
}

async function signInAs(user: { id: string; email: string }) {
  state.authUser = user
}

async function scenario1_worker_reads_and_posts() {
  console.log('\n--- S1: worker reads the shared room and posts with their identity ---')
  seedWorkspace()
  await signInAs(JOHN)

  const list = await supabaseBackend.listChatMessages(3)
  assert(!list.error, 'worker can read the chat')
  assert(list.data?.length === 3, `limit returns a window of 3 (${list.data?.length})`)
  assert(
    JSON.stringify(list.data?.map((m) => m.id)) === JSON.stringify(['c2', 'c3', 'c4']),
    `newest window, oldest first: ${JSON.stringify(list.data?.map((m) => m.id))}`
  )

  const members = await supabaseBackend.listChatMembers()
  assert(!members.error && members.data?.length === 3, `roster has the admin + 2 workers (${members.data?.length})`)
  assert(members.data?.[0]?.role === 'admin' && members.data?.[0]?.name === 'Admin', 'the admin is listed first')
  assert(
    members.data?.[0]?.avatar_url === 'data:admin',
    'the admin picture comes from the workspace settings row'
  )
  const john = members.data?.find((m) => m.worker_id === 'w-john')
  assert(john?.name === 'John Smith' && john?.position === 'Foreman' && john?.avatar_url === 'data:john', 'worker rows carry name, role/position and picture')
  assert(members.data?.some((m) => m.worker_id === 'w-sarah' && m.worker_status === 'inactive'), 'inactive workers are still listed (with their status)')
  assert(state.calls.some((c: any) => c.rpc === 'workspace_members'), 'the roster is read through the SECURITY DEFINER function')

  const posted = await supabaseBackend.sendChatMessage('  On site now.  ')
  assert(!posted.error && posted.data?.body === 'On site now.', 'worker posts a trimmed message')
  assert(posted.data?.author_role === 'worker' && posted.data?.author_name === 'John Smith', 'the posted message is stamped with the worker name + role')
  assert(posted.data?.worker_id === 'w-john' && posted.data?.author_position === 'Foreman', 'the message links the worker row and their role/position')
  assert(posted.data?.author_avatar_url === 'data:john', 'the message carries the worker profile picture')
  assert(state.calls.some((c: any) => c.rpc === 'post_chat_message'), 'posting goes through the post_chat_message RPC')
  assert(state.chat.at(-1)?.user_id === ADMIN.id, 'the row is owned by the workspace admin')

  const empty = await supabaseBackend.sendChatMessage('    ')
  assert(empty.error === 'Write a message first.', 'empty messages are refused client-side')
  const long = await supabaseBackend.sendChatMessage('x'.repeat(2001))
  assert(long.error?.includes('too long'), 'over-long messages are refused client-side')
}

async function scenario2_admin_view() {
  console.log('\n--- S2: the admin posts into the same room ---')
  seedWorkspace()
  await signInAs(ADMIN)
  const before = (await supabaseBackend.listChatMessages(100)).data?.length ?? 0
  const posted = await supabaseBackend.sendChatMessage('Nice work everyone.')
  assert(!posted.error, 'admin can post')
  assert(posted.data?.author_role === 'admin' && posted.data?.author_name === 'Admin', 'admin messages are labelled Admin')
  assert(posted.data?.worker_id === null, 'admin messages are not linked to a worker row')
  assert(posted.data?.author_avatar_url === 'data:admin', 'the admin picture comes from settings')
  const after = (await supabaseBackend.listChatMessages(100)).data?.length ?? 0
  assert(after === before + 1, 'the admin reads the same room the worker posted into')
}

async function scenario3_unmigrated_database() {
  console.log('\n--- S3: database without the chat migration ---')
  seedWorkspace()
  state.missingTables = ['chat_messages']

  await signInAs(JOHN)
  const read = await supabaseBackend.listChatMessages(50)
  assert(!!read.error && /chat-messages\.sql/.test(read.error ?? ''), `a worker gets a migration hint (got: ${read.error})`)
  const post = await supabaseBackend.sendChatMessage('hello')
  assert(!!post.error && !/row-level security/.test(post.error ?? ''), 'a worker never sees a raw RLS error')

  state.missingTables = []
  state.missingFunctions = ['post_chat_message', 'workspace_members']
  await signInAs(ADMIN)
  const fallbackPost = await supabaseBackend.sendChatMessage('Direct insert works for the admin.')
  assert(!fallbackPost.error && fallbackPost.data?.author_name === 'Admin', 'admin falls back to a direct insert when the RPC is missing')
  const roster = await supabaseBackend.listChatMembers()
  assert(!roster.error && roster.data?.[0]?.role === 'admin', 'roster falls back to the admin + readable workers')
  assert(roster.data?.length === 3, `fallback roster size (${roster.data?.length})`)
  const workerRoster = await (async () => {
    await signInAs(JOHN)
    return supabaseBackend.listChatMembers()
  })()
  assert(workerRoster.data?.some((m: any) => m.role === 'admin'), 'a worker still sees the admin in the fallback roster')
  assert(workerRoster.data?.length === 2, `a worker's fallback roster is themselves + the admin (${workerRoster.data?.length})`)
}

async function main() {
  await scenario1_worker_reads_and_posts()
  await scenario2_admin_view()
  await scenario3_unmigrated_database()
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall chat/supabase checks passed')
  if (failures) process.exit(1)
}

await main()
