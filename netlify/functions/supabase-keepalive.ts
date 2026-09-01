// Scheduled daily ping that keeps the Supabase project from pausing.
//
// Free-tier Supabase projects are automatically paused after ~7 days without
// any API/database activity. Netlify runs this function on a schedule (see
// [functions."supabase-keepalive"] in netlify.toml) and each run makes two
// lightweight requests against the project, which registers activity and
// resets the inactivity clock — so the project never sleeps.
//
// Only the publishable (browser-safe) key is used; no secret key needed.

const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const publishableKey =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_ANON_KEY

const PING_TARGETS = [
  // PostgREST query — reaches the database itself (a real activity signal).
  { path: '/rest/v1/settings?select=id&limit=1', label: 'database (settings)' },
  // Auth service health check — reaches the project's Auth API.
  { path: '/auth/v1/health', label: 'auth service' },
]

export default async function handler(_request: Request) {
  if (!url || !publishableKey) {
    return new Response(
      'Supabase keep-alive is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.',
      { status: 500 },
    )
  }

  const base = url.replace(/\/+$/, '')
  let okCount = 0
  const results: string[] = []

  for (const target of PING_TARGETS) {
    try {
      const response = await fetch(`${base}${target.path}`, {
        headers: {
          apikey: publishableKey,
          authorization: `Bearer ${publishableKey}`,
        },
      })

      // ANY HTTP response means the project woke up and answered — an empty
      // result set or even a 4xx (RLS denying the select) still registers
      // activity with Supabase, which is all this ping needs.
      await response.arrayBuffer().catch(() => undefined)
      okCount++
      results.push(`${target.label} -> HTTP ${response.status}`)
    } catch (error) {
      // A network-level error could mean the project is paused/unreachable.
      results.push(`${target.label} -> FAILED: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const summary = `Supabase keep-alive ping: ${okCount}/${PING_TARGETS.length} OK | ${results.join(' | ')}`
  console.log(summary)
  return new Response(summary, {
    status: okCount === PING_TARGETS.length ? 200 : 207,
    headers: { 'Content-Type': 'text/plain' },
  })
}
