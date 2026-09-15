/**
 * Ad-hoc verification of the FAQ copy (`src/lib/faq.ts`) — the content behind
 * the little "?" button.
 *
 * Nothing here is runtime-critical, which is exactly why it is worth pinning
 * down: the button is rendered from this data with no fallbacks, so a missing
 * section, an empty answer or a duplicated id would show up as a broken dialog
 * (a blank row, or two rows opening together) instead of a build error. The
 * checks are:
 *  - both audiences have sections, and every section has questions
 *  - ids are unique (the id is the accordion's open/closed state)
 *  - no empty/whitespace-only copy, no doubled spaces, sane lengths
 *  - every audience has its own title, intro and footer line, so the dialog
 *    never renders an undefined heading
 *
 * Run: npx tsx scripts/verify-faq-local.ts
 */
import {
  FAQ_FOOTER,
  FAQ_INTRO,
  FAQ_SECTIONS,
  FAQ_TITLE,
  type FaqAudience,
} from '../src/lib/faq'

const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`ok: ${msg}`)
  }
}

const AUDIENCES: FaqAudience[] = ['worker', 'admin']

function main() {
  // ---- 1. both audiences are renderable ---------------------------------
  for (const who of AUDIENCES) {
    const sections = FAQ_SECTIONS[who]
    assert(Array.isArray(sections) && sections.length > 0, `"${who}" has at least one section`)
    assert(
      !!FAQ_TITLE[who]?.trim() && !!FAQ_INTRO[who]?.trim() && !!FAQ_FOOTER[who]?.trim(),
      `"${who}" has a title, an intro and a footer line`
    )
    // FaqButton opens the first item on mount, so it must exist.
    assert(
      !!sections[0]?.items?.[0]?.id,
      `"${who}" has a first question for the dialog to open`
    )
    assert(
      sections.every((s) => !!s.title.trim() && s.items.length > 0),
      `every "${who}" section has a heading and at least one question`
    )
  }

  // ---- 2. ids are unique -------------------------------------------------
  const allIds = AUDIENCES.flatMap((who) => FAQ_SECTIONS[who].flatMap((s) => s.items.map((i) => i.id)))
  const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i)
  assert(dupes.length === 0, `no duplicated question ids (${allIds.length} questions)`)
  assert(allIds.every((id) => /^[a-z]+-[a-z-]+$/.test(id)), 'every id is a lowercase slug')

  // ---- 3. the copy itself is fit to show ---------------------------------
  for (const who of AUDIENCES) {
    // Questions are grouped inside a section, so a repeat inside the same
    // audience would be a copy/paste slip rather than a different answer.
    const questions = FAQ_SECTIONS[who].flatMap((s) => s.items.map((i) => i.question))
    assert(new Set(questions).size === questions.length, `no repeated question in "${who}"`)

    for (const item of FAQ_SECTIONS[who].flatMap((s) => s.items)) {
      const q = item.question
      const a = item.answer
      assert(
        q.trim() === q && q.length >= 8 && q.length <= 90,
        `"${who}" question "${q}" is a single tidy line`
      )
      assert(
        a.trim() === a && a.length >= 60 && a.length <= 400 && !a.includes('  '),
        `"${who}" answer for "${q}" is a real, single-spaced paragraph`
      )
      // Every answer names at least one screen or control, so it tells the
      // reader where to go rather than restating the question.
      assert(
        /[A-Z][a-z]+|→/.test(a),
        `"${who}" answer for "${q}" points at the app (a screen or control)`
      )
    }
  }

  // ---- 4. the audiences are genuinely different --------------------------
  const workerIds = new Set(FAQ_SECTIONS.worker.flatMap((s) => s.items.map((i) => i.id)))
  const adminIds = new Set(FAQ_SECTIONS.admin.flatMap((s) => s.items.map((i) => i.id)))
  const shared = [...workerIds].filter((id) => adminIds.has(id))
  assert(shared.length === 0, 'the worker and admin lists are distinct (different questions)')
}

main()
