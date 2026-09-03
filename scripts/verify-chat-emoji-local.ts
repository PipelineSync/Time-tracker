/**
 * Ad-hoc verification of the chat composer's emoji and sticker support, plus
 * emoji reactions, in demo mode (local storage):
 *
 *   * a sticker message is a `[sticker:slug]` token in the body — the chat table
 *     is unchanged, and the token still reads sensibly in a notification;
 *   * a reaction is one row per (message, member, emoji), and sending the same
 *     emoji again takes it back;
 *   * nobody can react to a message that is not there.
 *
 * Run: npx tsx scripts/verify-chat-emoji-local.ts
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
  const {
    stickerToken,
    stickerSlug,
    stickerLabel,
    isStickerToken,
    splitChatBody,
    stickerSlugsIn,
    stripStickerTokens,
    chatPlainText,
    chatNotificationText,
  } = await import('../src/lib/chat')
  const { localBackend } = await import('../src/lib/localDb')

  // 1) The token contract the client and the backends both rely on.
  assert(stickerToken('side-eye-cat') === '[sticker:side-eye-cat]', 'a sticker sends as a token in the body')
  assert(stickerSlug('Side Eye Cat.png') === 'side-eye-cat', 'a file name becomes the slug a message refers to')
  assert(stickerLabel('thumbs-up-tears') === 'Thumbs up tears', 'a slug reads as a label')
  assert(isStickerToken('  [sticker:cheeky-grin]  '), 'a lone token is recognised')
  assert(!isStickerToken('[sticker:nope] ok'), 'a message with words alongside is not just a sticker')
  assert(
    JSON.stringify(splitChatBody('nice [sticker:side-eye-cat] work')) ===
      JSON.stringify([
        { kind: 'text', text: 'nice ' },
        { kind: 'sticker', slug: 'side-eye-cat' },
        { kind: 'text', text: ' work' },
      ]),
    'text around a sticker is kept, in order'
  )
  assert(
    JSON.stringify(stickerSlugsIn('[sticker:a] then [sticker:b] and [sticker:a]')) === JSON.stringify(['a', 'b']),
    'the slugs in a body are listed once each, in order'
  )
  assert(stripStickerTokens('[sticker:a] thanks!') === 'thanks!', 'stripping leaves the typed words')
  assert(chatNotificationText({ author_name: 'John', body: 'nice [sticker:side-eye-cat] work' }) === 'John: nice [Side eye cat] work', 'a notification names the sticker instead of leaking the token')
  assert(chatNotificationText({ author_name: 'John', body: '[sticker:not_shipped_anymore]' }) === 'John: [Not shipped anymore]', 'an unknown sticker still reads as a label, never a broken image path')

  // 2) A worker reacts; the admin reads it from the same shared room. The admin
  //    signs in first because that is what seeds the demo workspace.
  const boot = await localBackend.signIn('admin', 'admin.pipelinesync')
  assert(!boot.error && boot.data?.role === 'admin', 'the admin signs in (seeding the demo workspace)')
  const john = await localBackend.signIn('john@example.com', 'worker123')
  assert(!john.error && john.data?.role === 'worker', 'worker can sign in')
  const posted = await localBackend.sendChatMessage('Site is locked up, key is in the box.')
  assert(!posted.error && posted.data?.id, 'worker can post a message')
  const messageId = posted.data!.id

  const first = await localBackend.toggleChatReaction(messageId, '👍')
  assert(!first.error && first.data?.length === 1, 'a worker can react to a message')
  assert(first.data?.[0]?.author_name === 'John Smith', 'the reaction is stamped with who reacted')
  assert(first.data?.[0]?.message_id === messageId, 'the reaction is tied to the message')

  const again = await localBackend.toggleChatReaction(messageId, '👍')
  assert(!again.error && again.data?.length === 0, 'reacting with the same emoji again takes it back')

  await localBackend.toggleChatReaction(messageId, '🙏')
  const two = await localBackend.toggleChatReaction(messageId, '✅')
  assert((two.data?.length ?? 0) === 2, 'one member may react with several emoji')
  const deduped = await localBackend.toggleChatReaction(messageId, '✅')
  assert((deduped.data?.length ?? 0) === 1, 'and never twice with the same one')

  // The workspace list carries the demo room's starter reactions too, so count
  // only the ones on this script's own message.
  const room = await localBackend.listChatReactions()
  const onMine = (room.data ?? []).filter((r) => r.message_id === messageId)
  assert(!room.error && onMine.length === 1, `the workspace reaction list carries it (${onMine.length})`)
  assert(onMine.every((r) => r.author_name === 'John Smith'), 'and names who reacted')

  // 3) Junk is refused rather than stored.
  assert((await localBackend.toggleChatReaction('no-such-message', '👍')).error !== null, 'reacting to a message that is not there fails')
  assert((await localBackend.toggleChatReaction(messageId, '   ')).error !== null, 'an empty reaction is refused')
  assert((await localBackend.toggleChatReaction(messageId, 'this is a whole sentence')).error !== null, 'a reaction must be a single emoji')

  // 4) A sticker message travels through the real backend like any other text.
  const stickerPost = await localBackend.sendChatMessage(stickerToken('thumbs-up-tears'))
  assert(!stickerPost.error && stickerPost.data?.body === '[sticker:thumbs-up-tears]', 'a sticker can be sent as a message')
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const notifs = await localBackend.listNotifications()
  assert(
    (notifs.data ?? []).some((n) => n.type === 'chat' && n.message === 'John Smith: [Thumbs up tears]'),
    'the notification other members get describes the sticker'
  )
  const adminEmoji = await localBackend.sendChatMessage('👍')
  assert(!adminEmoji.error && adminEmoji.data?.body === '👍', 'the admin can post emoji too')

  // 5) Reactions are quiet: they never notify, so a "thanks 👍" does not buzz.
  const before = (await localBackend.listNotifications()).data?.length ?? 0
  const adminOnJohns = await localBackend.toggleChatReaction(messageId, '👍')
  assert(!adminOnJohns.error && adminOnJohns.data?.length === 2, 'the admin can react to the worker message too')
  const after = (await localBackend.listNotifications()).data?.length ?? 0
  assert(after === before, 'reacting creates no notification')

  // 6) Deleting a worker cleans up after them: their reactions go, and nothing
  //    is left reacting to a message that went with them (the SQL cascade).
  await localBackend.signIn('admin', 'admin.pipelinesync')
  const adminRoom = await localBackend.listChatMessages(500)
  const johnsMessages = (adminRoom.data ?? []).filter((m) => m.author_name === 'John Smith')
  assert(johnsMessages.length > 0, 'the worker has messages in the room to lose')
  const onAdminsMessage = await localBackend.toggleChatReaction(johnsMessages[0].id, '👍')
  assert(!onAdminsMessage.error, 'the admin reacts to one of them')
  const doomedIds = new Set(johnsMessages.map((m) => m.id))
  const johnId = (await localBackend.listChatMembers()).data?.find((m) => m.name === 'John Smith')?.worker_id
  assert(johnId, 'the worker is in the member list')
  const removed = await localBackend.deleteWorker(johnId!)
  assert(!removed.error, 'admin can delete the worker')
  const afterDelete = await localBackend.listChatReactions()
  assert(
    (afterDelete.data ?? []).every((r) => !doomedIds.has(r.message_id) && r.author_name !== 'John Smith'),
    'their reactions, and anything left on their deleted messages, are gone'
  )
  const surviving = await localBackend.listChatMessages(500)
  assert(
    (afterDelete.data ?? []).every((r) => surviving.data?.some((m) => m.id === r.message_id)),
    'no reaction points at a message that no longer exists'
  )

  console.log(process.exitCode ? '\nsome emoji/sticker checks failed' : '\nall emoji/sticker checks passed')
}

await main()
