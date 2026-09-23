/**
 * GET|POST /oauth/authorize — the sign-in and consent screen.
 *
 * GET  renders the login page: Work Tracker email + password, plus a plain
 *      statement of what Claude will be able to do.
 * POST validates those credentials against Supabase Auth and, on success,
 *      redirects back to Claude with a single-use authorization code.
 *
 * Two things make this safe rather than merely functional:
 *
 *  1. The redirect target is re-checked against the URI the *client registered*
 *     (and against the allow-list), so a tampered `redirect_uri` cannot ship a
 *     fresh authorization code to an attacker's server.
 *  2. The Supabase session created here is stored with the authorization code
 *     and later attached to the MCP token, so every tool call runs as the
 *     person who typed their password — with their exact permissions.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createCode, getClient } from './lib/mcp/oauth-store'
import {
  isAllowedRedirectUri,
  oauthError,
  parseBody,
  redirectWithParams,
} from './lib/mcp/oauth'
import { page } from './lib/mcp/authorize-page'

const CODE_TTL_SECONDS = 300

/** A browser-facing client: this is a real user typing a real password. */
function authClient() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const anonKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error('Supabase URL / publishable key are not configured for the connector.')
  }
  return createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Every query parameter the login page must carry through the POST. */
interface PendingRequest {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  codeChallengeMethod: string
}

function readPending(params: URLSearchParams): PendingRequest | string {
  const clientId = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const codeChallenge = params.get('code_challenge') ?? ''
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'S256'
  const state = params.get('state') ?? ''

  if (!clientId) return 'Missing client_id.'
  if (!redirectUri) return 'Missing redirect_uri.'
  if (!codeChallenge) return 'Missing code_challenge. This client must use PKCE.'
  if (codeChallengeMethod !== 'S256') {
    return 'Only the S256 PKCE method is supported.'
  }
  return { clientId, redirectUri, state, codeChallenge, codeChallengeMethod }
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === 'GET') {
    const pending = readPending(url.searchParams)
    if (typeof pending === 'string') {
      return new Response(page({ error: pending }), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    const client = await getClient(pending.clientId)
    if (!client) {
      return new Response(
        page({ error: 'That app is not registered with this connector. Remove it in Claude and add it again.' }),
        { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
      )
    }
    // The redirect URI must be one the client actually registered — this is the
    // check that stops an authorization code being stolen by swapping the
    // redirect_uri on the URL.
    if (!client.redirect_uris.includes(pending.redirectUri) || !isAllowedRedirectUri(pending.redirectUri)) {
      return new Response(page({ error: 'That redirect address is not registered for this app.' }), {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }

    return new Response(page({ pending }), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // The login form is a form post; block framing so it cannot be
        // clickjacked into an invisible iframe.
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      },
    })
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, POST' } })
  }

  const body = await parseBody(request)
  const pending = readPending(
    new URLSearchParams({
      client_id: body.client_id ?? '',
      redirect_uri: body.redirect_uri ?? '',
      state: body.state ?? '',
      code_challenge: body.code_challenge ?? '',
      code_challenge_method: body.code_challenge_method ?? 'S256',
    }),
  )
  if (typeof pending === 'string') {
    return oauthError(400, 'invalid_request', pending)
  }

  const client = await getClient(pending.clientId)
  if (!client) return oauthError(400, 'invalid_client', 'Unknown client.')
  if (!client.redirect_uris.includes(pending.redirectUri) || !isAllowedRedirectUri(pending.redirectUri)) {
    return oauthError(400, 'invalid_request', 'redirect_uri is not registered for this client.')
  }

  const email = (body.email ?? '').trim()
  const password = body.password ?? ''
  if (!email || !password) {
    return new Response(page({ pending, error: 'Enter your Work Tracker email and password.' }), {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  let session
  try {
    const { data, error } = await authClient().auth.signInWithPassword({ email, password })
    if (error || !data.session) {
      // Deliberately one message for "no such user" and "wrong password":
      // distinguishing them turns this page into an account enumerator.
      return new Response(page({ pending, error: 'That email and password do not match an account.' }), {
        status: 401,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      })
    }
    session = data.session
  } catch (error) {
    console.error('[mcp-oauth] sign-in failed:', error)
    return new Response(page({ pending, error: 'Could not reach the sign-in service. Try again.' }), {
      status: 502,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  }

  // A deactivated worker account must not be able to mint a connector token,
  // even though Supabase Auth would happily accept the password.
  const sb = authClient()
  await sb.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  })
  const { data: profile } = await sb
    .from('profiles')
    .select('role, worker_id')
    .eq('user_id', session.user.id)
    .maybeSingle()

  if (profile?.role === 'worker' && profile.worker_id) {
    const { data: worker } = await sb
      .from('workers')
      .select('status')
      .eq('id', profile.worker_id)
      .maybeSingle()
    if ((worker as { status?: string } | null)?.status === 'inactive') {
      return new Response(
        page({ pending, error: 'This account is deactivated. Ask your administrator to reactivate it.' }),
        { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
      )
    }
  }

  try {
    const code = await createCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      scope: 'worktracker.read worktracker.write',
      userId: session.user.id,
      supabaseAccessToken: session.access_token,
      supabaseRefreshToken: session.refresh_token,
      ttlSeconds: CODE_TTL_SECONDS,
    })

    const params: Record<string, string> = { code }
    if (pending.state) params.state = pending.state
    return redirectWithParams(pending.redirectUri, params)
  } catch (error) {
    console.error('[mcp-oauth] could not issue the authorization code:', error)
    return redirectWithParams(pending.redirectUri, {
      error: 'server_error',
      error_description: 'Could not complete the sign-in. Try again.',
      ...(pending.state ? { state: pending.state } : {}),
    })
  }
}
