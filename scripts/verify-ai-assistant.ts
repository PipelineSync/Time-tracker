/**
 * End-to-end verification of the in-app AI assistant (POST /ai-chat).
 *
 * Runs the real handler — netlify/functions/ai-chat.ts, the real assistant
 * engine and the real connector tools — against two stand-ins:
 *   * the fake Supabase from scripts/mcp-mock (row-level access per account), and
 *   * a fake Claude API on localhost (the SDK is pointed at it with
 *     ANTHROPIC_BASE_URL), which replays scripted model turns and records
 *     every request it receives.
 *
 * No real Anthropic API call is made. What this proves:
 *   - reads run straight away, as the signed-in worker, and only see their rows
 *   - anything that changes data stops for approval and runs only once approved
 *   - Cancel never runs the action; a missing decision never runs it
 *   - a write the worker has no permission for is refused by the tool
 *   - the admin's workspace switch, a missing key and a bad session are refused
 *   - the request to Claude uses the agreed model, tools and refusal fallback
 *
 * Run: npx tsx scripts/verify-ai-assistant.ts
 */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'

const { startFakeSupabase, resetState, addAccount, table, makeJwt } = await import('./mcp-mock/fake-supabase.mjs')

let checks = 0
let failures = 0
function assert(cond: unknown, msg: string) {
  checks++
  if (cond) console.log(`ok: ${msg}`)
  else {
    failures++
    console.error(`FAIL: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Fake Claude API
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>
const script: { content: Block[]; stop_reason: string }[] = []
const requests: { body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = []

const claude = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  requests.push({ body: JSON.parse(raw || '{}'), headers: req.headers })
  const next = script.shift()
  if (!next) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no scripted turn left' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: next.content,
      stop_reason: next.stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  )
})
await new Promise<void>((resolve) => claude.listen(0, '127.0.0.1', resolve))
const claudeUrl = `http://127.0.0.1:${(claude.address() as AddressInfo).port}`

// ---------------------------------------------------------------------------
// Fake Supabase + environment, then import the handler
// ---------------------------------------------------------------------------

const supabase = await startFakeSupabase()
process.env.VITE_SUPABASE_URL = supabase.url
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = supabase.anonKey
process.env.VITE_SUPABASE_ANON_KEY = supabase.anonKey
process.env.SUPABASE_URL = supabase.url
process.env.SUPABASE_SECRET_KEY = supabase.serviceRoleKey
process.env.ANTHROPIC_BASE_URL = claudeUrl
process.env.ANTHROPIC_API_KEY = 'test-key'

const aiChat = (await import('../netlify/functions/ai-chat')).default
const { trimHistory } = await import('../netlify/functions/lib/ai/assistant')

const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const ANA_ID = '22222222-2222-4222-8222-222222222222'
const BEN_ID = '33333333-3333-4333-8333-333333333333'
const ANA_WORKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BEN_WORKER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLIENT_ACME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function seed() {
  resetState()
  addAccount({ userId: ADMIN_ID, email: 'admin@example.com', password: 'x', role: 'admin' })
  addAccount({ userId: ANA_ID, email: 'ana@example.com', password: 'x', role: 'worker', workerId: ANA_WORKER })
  addAccount({ userId: BEN_ID, email: 'ben@example.com', password: 'x', role: 'worker', workerId: BEN_WORKER })
  table('settings').push({ user_id: ADMIN_ID, business_name: 'PipelineSync', currency: 'PHP', timezone: 'Asia/Manila', default_hourly_rate: 250 })
  table('workers').push(
    { id: ANA_WORKER, user_id: ADMIN_ID, name: 'Ana Reyes', email: 'ana@example.com', hourly_rate: 300, status: 'active', permissions: [] },
    { id: BEN_WORKER, user_id: ADMIN_ID, name: 'Ben Cruz', email: 'ben@example.com', hourly_rate: 200, status: 'active', permissions: [] },
  )
  table('clients').push({ id: CLIENT_ACME, user_id: ADMIN_ID, name: 'Acme Corp', status: 'active' })
  table('time_entries').push(
    { id: 'eeeeeee1-1111-4111-8111-111111111111', user_id: ADMIN_ID, worker_id: ANA_WORKER, client_id: CLIENT_ACME, start_time: '2026-09-01T01:00:00.000Z', end_time: '2026-09-01T09:00:00.000Z', break_minutes: 60, hourly_rate: 300, total_minutes: 420, earnings: 2100, settled_at: null, notes: 'ANA-PRIVATE-NOTE' },
    { id: 'eeeeeee2-2222-4222-8222-222222222222', user_id: ADMIN_ID, worker_id: BEN_WORKER, client_id: CLIENT_ACME, start_time: '2026-09-01T02:00:00.000Z', end_time: '2026-09-01T06:00:00.000Z', break_minutes: 0, hourly_rate: 200, total_minutes: 240, earnings: 800, settled_at: null, notes: 'ben-note' },
  )
}
seed()

const BEN_TOKEN = makeJwt(BEN_ID)

async function chat(body: unknown, token: string | null = BEN_TOKEN) {
  const res = await aiChat(
    new Request('https://tracker.example.com/ai-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input })
const lastMessage = (b: Record<string, any>) => b.messages[b.messages.length - 1]

// ===========================================================================
// 1. A read runs straight away, as Ben, and sees only Ben's rows
// ===========================================================================

script.push({ content: [{ type: 'thinking', thinking: '', signature: 'sig-1' }, toolUse('tu_read', 'list_time_entries')], stop_reason: 'tool_use' })
let r = await chat({ messages: [{ role: 'user', content: 'How many hours did I work?' }] })
assert(r.status === 200 && r.body.status === 'continue', 'a read-only tool call continues without asking')
const readResult = lastMessage(r.body).content[0]
assert(readResult.type === 'tool_result' && readResult.tool_use_id === 'tu_read' && !readResult.is_error, 'the read ran and its result was appended')
assert(String(readResult.content).includes('ben-note'), "the result contains Ben's own entry")
assert(!String(readResult.content).includes('ANA-PRIVATE-NOTE'), "the result does not contain Ana's entry (row-level access holds)")
assert(r.body.messages[1].content[0].type === 'thinking' && r.body.messages[1].content[0].signature === 'sig-1', 'thinking blocks are kept unchanged in the history')

const sent = requests[0]
assert(sent.body.model === 'claude-sonnet-5-5', 'the request uses claude-sonnet-5-5')
assert(sent.body.fallbacks === 'default', 'refusal fallback is on ("default")')
assert(String(sent.headers['anthropic-beta'] ?? '').includes('server-side-fallback-2026-07-01'), 'the fallback beta header is sent')
assert(Array.isArray(sent.body.tools) && (sent.body.tools as unknown[]).length === 36, 'all 36 connector tools are offered')
assert(!('tool_choice' in sent.body) && !('thinking' in sent.body), 'no forced tool choice and no thinking override (both 400 on this model)')
assert(JSON.stringify(sent.body.system).includes('Ben Cruz'), 'the system prompt names the signed-in person')
assert((sent.body.output_config as { effort?: string })?.effort === 'low', 'effort is set explicitly')

script.push({ content: [{ type: 'text', text: 'You worked **4h** on Sep 1.' }], stop_reason: 'end_turn' })
r = await chat({ messages: r.body.messages })
assert(r.body.status === 'done' && lastMessage(r.body).content[0].text.includes('4h'), 'the final answer finishes the turn')
const afterRead = r.body.messages

// ===========================================================================
// 2. A write stops for approval; nothing changes until approved
// ===========================================================================

const tasksBefore = table('tasks').length
script.push({ content: [toolUse('tu_task', 'create_task', { title: 'Write tests' })], stop_reason: 'tool_use' })
r = await chat({ messages: [...afterRead, { role: 'user', content: 'Add a task: Write tests' }] })
assert(r.body.status === 'approval', 'a data-changing tool stops for approval')
assert(r.body.pending?.length === 1 && r.body.pending[0].name === 'create_task' && r.body.pending[0].title === 'Create a task', 'the pending action names the tool and its title')
assert(table('tasks').length === tasksBefore, 'nothing was written before approval')
const awaiting = r.body.messages

r = await chat({ messages: awaiting })
assert(r.body.status === 'approval' && table('tasks').length === tasksBefore, 'resending without a decision asks again and still writes nothing')

r = await chat({ messages: awaiting, decisions: { tu_task: 'reject' } })
const rejected = lastMessage(r.body).content[0]
assert(r.body.status === 'continue' && rejected.is_error === true && /declined/.test(rejected.content), 'Cancel returns a "declined" result to the model')
assert(table('tasks').length === tasksBefore, 'Cancel wrote nothing')

r = await chat({ messages: awaiting, decisions: { tu_task: 'approve' } })
const approved = lastMessage(r.body).content[0]
assert(r.body.status === 'continue' && !approved.is_error, 'Approve runs the action')
const created = table('tasks').find((t: Record<string, unknown>) => t.title === 'Write tests')
assert(created && created.worker_id === BEN_WORKER, "the task landed on Ben's own board")

// A decision for a different id does not unlock the pending one.
r = await chat({ messages: awaiting, decisions: { someone_else: 'approve' } })
assert(r.body.status === 'approval', 'an approval for another action does not unlock this one')

// ===========================================================================
// 3. Mixed reads and writes: everything waits, then runs together
// ===========================================================================

script.push({ content: [toolUse('tu_r2', 'list_clients'), toolUse('tu_w2', 'add_entry_note', { entry_id: 'eeeeeee2-2222-4222-8222-222222222222', note: 'from AI' })], stop_reason: 'tool_use' })
r = await chat({ messages: [...afterRead, { role: 'user', content: 'Note my entry' }] })
assert(r.body.status === 'approval' && r.body.pending.length === 1 && r.body.pending[0].id === 'tu_w2', 'only the write is listed for approval')
r = await chat({ messages: r.body.messages, decisions: { tu_w2: 'approve' } })
const results = lastMessage(r.body).content
assert(results.length === 2 && results.every((b: Block) => b.type === 'tool_result'), 'both results return together in one message')

// ===========================================================================
// 4. A write Ben has no permission for is refused by the tool itself
// ===========================================================================

const paymentsBefore = table('payments').length
script.push({ content: [toolUse('tu_settle', 'settle_worker', { worker_id: ANA_WORKER })], stop_reason: 'tool_use' })
r = await chat({ messages: [...afterRead, { role: 'user', content: "Settle Ana's time" }] })
r = await chat({ messages: r.body.messages, decisions: { tu_settle: 'approve' } })
const settle = lastMessage(r.body).content[0]
assert(settle.is_error === true && /permission/i.test(settle.content), 'settling pay without payments.manage is refused, naming the permission')
assert(table('payments').length === paymentsBefore, 'no payment was created')

// ===========================================================================
// 5. Refusal, fallback marker, unknown tool
// ===========================================================================

script.push({ content: [], stop_reason: 'refusal' })
r = await chat({ messages: [{ role: 'user', content: 'something declined' }] })
assert(r.body.status === 'done' && /can't help/.test(lastMessage(r.body).content[0].text), 'a refusal ends the turn with a short message')

script.push({
  content: [
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
    { type: 'text', text: 'Answered by the fallback model.' },
  ],
  stop_reason: 'end_turn',
})
r = await chat({ messages: [{ role: 'user', content: 'hi' }] })
assert(lastMessage(r.body).content.every((b: Block) => b.type !== 'fallback'), 'the fallback audit marker is not stored in the history')

script.push({ content: [toolUse('tu_bad', 'drop_database')], stop_reason: 'tool_use' })
r = await chat({ messages: [{ role: 'user', content: 'hi' }] })
r = await chat({ messages: r.body.messages, decisions: { tu_bad: 'approve' } })
assert(/Unknown tool/.test(lastMessage(r.body).content[0].content), 'an unknown tool name is refused')

// ===========================================================================
// 6. Refusals at the door
// ===========================================================================

r = await chat({ messages: [{ role: 'user', content: 'hi' }] }, null)
assert(r.status === 401, 'no session → 401')
r = await chat({ messages: [{ role: 'user', content: 'hi' }] }, 'not-a-real-token')
assert(r.status === 401, 'a bad session → 401')
r = await chat({ messages: [{ role: 'assistant', content: 'hi' }] })
assert(r.status === 400, 'a conversation must start with the user')

table('settings')[0].ai_assistant_enabled = false
const callsBefore = requests.length
r = await chat({ messages: [{ role: 'user', content: 'hi' }] })
assert(r.status === 403 && r.body.error === 'disabled', "the admin's switch turns the assistant off")
assert(requests.length === callsBefore, 'a switched-off workspace never reaches Claude')
table('settings')[0].ai_assistant_enabled = true

delete process.env.ANTHROPIC_API_KEY
r = await chat({ messages: [{ role: 'user', content: 'hi' }] })
assert(r.status === 503 && r.body.error === 'not_configured', 'a missing ANTHROPIC_API_KEY gives a clear setup message')
process.env.ANTHROPIC_API_KEY = 'test-key'

// ===========================================================================
// 7. History trimming
// ===========================================================================

const long: any[] = []
for (let i = 0; i < 60; i++) {
  long.push({ role: 'user', content: `question ${i}` })
  long.push({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: `s${i}` }, { type: 'text', text: `answer ${i}` }] })
}
const trimmed = trimHistory(long)
assert(trimmed.length < long.length && trimmed[0].role === 'user', 'a long history is cut at a user message')
assert(trimmed.every((m: any) => typeof m.content === 'string' || m.content.every((b: Block) => b.type !== 'thinking')), 'after trimming, no thinking block is replayed')
assert(JSON.stringify(trimmed).includes('answer 59'), 'the latest turns are kept')
const short = long.slice(0, 4)
assert(trimHistory(short) === short, 'a short history is passed through untouched')

// ===========================================================================

seed()
await supabase.stop()
claude.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.error(`${failures} FAILED`)
  process.exitCode = 1
}
