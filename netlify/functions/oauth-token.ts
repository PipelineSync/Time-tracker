/**
 * POST /oauth/token — the OAuth 2.1 token endpoint.
 *
 * Handles two grants:
 *   authorization_code — exchange a single-use code + PKCE verifier for tokens
 *   refresh_token      — swap a refresh token for a fresh pair (with rotation)
 *
 * Every response is `Cache-Control: no-store`; a cached token response is a
 * credential sitting in a CDN.
 */

import {
  consumeCode,
  createTokens,
  getClient,
  readCode,
  getRefreshToken,
  revokeTokenByHash,
  verifyClientSecret,
} from './lib/mcp/oauth-store'
import { oauthError, parseBody } from './lib/mcp/oauth'
import { verifyPkce, jwtExpiry } from './lib/mcp/crypto'
import { refreshSupabaseSession } from './lib/mcp/session-refresh'
import { connectorConfigProblem, logConnectorEvent, missingConnectorEnv } from './lib/mcp/diagnostics'

const ACCESS_TTL_SECONDS = 3600
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30

function tokenResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  })
}

/** Client credentials may arrive in the body or as HTTP Basic auth. */
async function readClientAuth(
  request: Request,
  body: Record<string, string>,
): Promise<{ clientId: string; clientSecret: string | null }> {
  let clientId: string = body.client_id ?? ''
  let clientSecret: string | null = body.client_secret ?? null

  const header = request.headers.get('authorization')
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice(6))
      const separator = decoded.indexOf(':')
      if (separator > -1) {
        clientId = decodeURIComponent(decoded.slice(0, separator))
        clientSecret = decodeURIComponent(decoded.slice(separator + 1)) || null
      }
    } catch {
      /* malformed Basic header — fall back to the body values */
    }
  }

  return { clientId, clientSecret }
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    const response = new Response('Method not allowed.', {
      status: 405,
      headers: { Allow: 'POST' },
    })
    return response
  }

  // ---- Config preflight -----------------------------------------------------
  // A missing variable makes every exchange fail; naming it here turns "the
  // connector never connects" into a one-look fix. This is a JSON endpoint, so
  // the answer is an OAuth server_error whose description names the variable.
  const configProblem = connectorConfigProblem()
  if (configProblem) {
    logConnectorEvent('error', 'token.config_missing', { missing: missingConnectorEnv() })
    return oauthError(500, 'server_error', configProblem)
  }

  // An unexpected throw (database unreachable, a store bug) must come back as
  // a real OAuth error body, not Netlify's generic 500 page.
  try {
    return await handleTokenRequest(request)
  } catch (error) {
    logConnectorEvent('error', 'token.unhandled_error', {
      message: error instanceof Error ? error.message : String(error),
    })
    return oauthError(500, 'server_error', 'The token endpoint failed. Try again.')
  }
}

async function handleTokenRequest(request: Request): Promise<Response> {
  const body = await parseBody(request)
  const grantType = body.grant_type
  const { clientId, clientSecret } = await readClientAuth(request, body)

  if (!clientId) return oauthError(400, 'invalid_client', 'Missing client_id.')

  const client = await getClient(clientId)
  if (!client) return oauthError(401, 'invalid_client', 'Unknown client. Register again in Claude.')

  const secretOk = await verifyClientSecret(client, clientSecret)
  if (!secretOk) return oauthError(401, 'invalid_client', 'Client authentication failed.')

  // -------------------------------------------------------------------------
  // Authorization code grant
  // -------------------------------------------------------------------------
  if (grantType === 'authorization_code') {
    const code = body.code ?? ''
    const verifier = body.code_verifier ?? ''
    if (!code) return oauthError(400, 'invalid_request', 'Missing code.')

    // Verify first, consume second. Claiming the row before checking PKCE
    // would let anyone holding a stolen code destroy it by redeeming it with a
    // junk verifier, and would break a client that merely mistyped one.
    const record = await readCode(code, clientId)
    if (!record) {
      // Either reused, expired, or issued to a different client. One message
      // for all three so the endpoint cannot be used to probe code validity.
      return oauthError(400, 'invalid_grant', 'That authorization code is invalid or has expired.')
    }
    if (record.redirect_uri !== body.redirect_uri) {
      return oauthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.')
    }

    const pkceOk = await verifyPkce(verifier, record.code_challenge)
    if (!pkceOk) return oauthError(400, 'invalid_grant', 'PKCE verification failed.')

    // Claim it now. Losing this race means someone else redeemed the code in
    // the meantime, which is exactly the replay we want to refuse.
    const claimed = await consumeCode(code, clientId)
    if (!claimed) {
      return oauthError(400, 'invalid_grant', 'That authorization code is invalid or has expired.')
    }

    const issued = await createTokens({
      clientId,
      userId: record.user_id,
      scope: record.scope,
      supabaseAccessToken: record.supabase_access_token,
      supabaseRefreshToken: record.supabase_refresh_token,
      supabaseExpiresAt: expiresAtIso(record.supabase_access_token),
      accessTtlSeconds: ACCESS_TTL_SECONDS,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    })

    return tokenResponse({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: record.scope ?? 'worktracker.read worktracker.write',
    })
  }

  // -------------------------------------------------------------------------
  // Refresh token grant
  // -------------------------------------------------------------------------
  if (grantType === 'refresh_token') {
    const refreshToken = body.refresh_token ?? ''
    if (!refreshToken) return oauthError(400, 'invalid_request', 'Missing refresh_token.')

    const record = await getRefreshToken(refreshToken)
    if (!record) return oauthError(400, 'invalid_grant', 'That refresh token is invalid or has expired.')

    // Keep the Supabase session alive alongside the MCP token — otherwise the
    // connector would survive for 30 days but stop being able to read anything
    // after the first hour.
    let supabaseAccessToken = record.supabase_access_token
    let supabaseRefreshToken = record.supabase_refresh_token
    const exp = jwtExpiry(supabaseAccessToken)
    if (exp === null || exp * 1000 - Date.now() < 90 * 1000) {
      try {
        const refreshed = await refreshSupabaseSession(supabaseRefreshToken)
        supabaseAccessToken = refreshed.accessToken
        supabaseRefreshToken = refreshed.refreshToken
      } catch {
        return oauthError(400, 'invalid_grant', 'Your Work Tracker session expired. Sign in again in Claude.')
      }
    }

    const issued = await createTokens({
      clientId,
      userId: record.user_id,
      scope: record.scope,
      supabaseAccessToken,
      supabaseRefreshToken,
      supabaseExpiresAt: expiresAtIso(supabaseAccessToken),
      accessTtlSeconds: ACCESS_TTL_SECONDS,
      refreshTtlSeconds: REFRESH_TTL_SECONDS,
    })

    // Rotation: the old access token dies the moment its refresh token is
    // exchanged, so a stolen refresh token cannot be replayed in parallel.
    await revokeTokenByHash(record.token_hash)

    return tokenResponse({
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken,
      scope: record.scope ?? 'worktracker.read worktracker.write',
    })
  }

  return oauthError(400, 'unsupported_grant_type', `Unsupported grant_type "${grantType ?? ''}".`)
}

function expiresAtIso(accessToken: string): string | null {
  const exp = jwtExpiry(accessToken)
  return exp === null ? null : new Date(exp * 1000).toISOString()
}
