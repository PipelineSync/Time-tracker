/**
 * Persistence for the connector's OAuth 2.1 flow.
 *
 * Every read and write here goes through the service-role client, which is
 * the *only* thing that can touch these tables: `supabase/mcp-oauth.sql`
 * enables RLS and adds no policies, so the browser-side anon key is locked
 * out regardless of who is signed in.
 *
 * Secrets are hashed with `hashSecret()` before they are stored, which is why
 * the lookups below hash the incoming value rather than comparing directly.
 */

import { adminClient } from '../supabase'
import { hashSecret, randomSecret, safeEqual, sha256Base64Url } from './crypto'

/** OAuth clients registered with the connector. */
export interface OAuthClient {
  client_id: string
  client_secret_hash: string | null
  name: string | null
  redirect_uris: string[]
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
  scope: string | null
}

export interface OAuthCode {
  code_hash: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: string
  scope: string | null
  user_id: string
  supabase_access_token: string
  supabase_refresh_token: string
  expires_at: string
  consumed_at: string | null
}

export interface OAuthToken {
  token_hash: string
  refresh_token_hash: string | null
  client_id: string
  user_id: string
  scope: string | null
  supabase_access_token: string
  supabase_refresh_token: string
  supabase_expires_at: string | null
  expires_at: string
  refresh_expires_at: string
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Create a client. `redirectUris` are validated by the caller (see
 * `oauth/validate.ts`) — a bad redirect URI is the classic OAuth account-takeover
 * vector, so it is rejected before anything is written.
 */
export async function createClient(input: {
  redirectUris: string[]
  name?: string | null
  clientSecret?: string | null
  tokenEndpointAuthMethod?: string
  grantTypes?: string[]
  responseTypes?: string[]
  scope?: string | null
}): Promise<{ clientId: string; clientSecret: string | null }> {
  const clientId = randomSecret(24)
  const clientSecret = input.clientSecret ?? null
  const secretHash = clientSecret ? await sha256Base64Url(clientSecret) : null

  const { error } = await adminClient().from('mcp_oauth_clients').insert({
    client_id: clientId,
    client_secret_hash: secretHash,
    name: input.name?.slice(0, 200) ?? null,
    redirect_uris: input.redirectUris,
    grant_types: input.grantTypes ?? ['authorization_code', 'refresh_token'],
    response_types: input.responseTypes ?? ['code'],
    token_endpoint_auth_method: clientSecret
      ? (input.tokenEndpointAuthMethod ?? 'client_secret_post')
      : 'none',
    scope: input.scope ?? null,
  })

  if (error) throw new Error(`Could not register the OAuth client: ${error.message}`)
  return { clientId, clientSecret }
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const { data, error } = await adminClient()
    .from('mcp_oauth_clients')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle()
  if (error || !data) return null
  return data as OAuthClient
}

/**
 * Verify a client's secret, if it has one.
 *
 * A client with no stored secret is a public client (what Claude creates
 * through Dynamic Client Registration): it authenticates with PKCE alone, so
 * there is nothing to check and any presented secret is ignored.
 */
export async function verifyClientSecret(
  client: OAuthClient,
  presented: string | null,
): Promise<boolean> {
  if (!client.client_secret_hash) return true
  if (!presented) return false
  return safeEqual(await sha256Base64Url(presented), client.client_secret_hash)
}

export async function touchClient(clientId: string): Promise<void> {
  // Fire-and-forget: a bookkeeping column, never worth failing a request over.
  await adminClient()
    .from('mcp_oauth_clients')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .then(() => undefined, () => undefined)
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

/** Issue a single-use authorization code and return the value to hand back. */
export async function createCode(input: {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  scope: string | null
  userId: string
  supabaseAccessToken: string
  supabaseRefreshToken: string
  ttlSeconds?: number
}): Promise<string> {
  const code = randomSecret(32)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? 300) * 1000)

  const { error } = await adminClient().from('mcp_oauth_codes').insert({
    code_hash: await hashSecret('code', code),
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    scope: input.scope,
    user_id: input.userId,
    supabase_access_token: input.supabaseAccessToken,
    supabase_refresh_token: input.supabaseRefreshToken,
    expires_at: expiresAt.toISOString(),
  })

  if (error) throw new Error(`Could not create the authorization code: ${error.message}`)
  return code
}

/**
 * Read a code without consuming it.
 *
 * Needed because PKCE has to be checked *before* the code is burned: if the
 * code were claimed first, anyone who intercepted one could invalidate it by
 * redeeming it with a junk verifier — and a client that hit a typo would find
 * its own login dead.
 */
export async function readCode(code: string, clientId: string): Promise<OAuthCode | null> {
  const { data, error } = await adminClient()
    .from('mcp_oauth_codes')
    .select('*')
    .eq('code_hash', await hashSecret('code', code))
    .eq('client_id', clientId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (error || !data) return null
  return data as OAuthCode
}

/**
 * Consume a code, atomically.
 *
 * Single-use is enforced by claiming the row with an update guarded on
 * `consumed_at is null`, so two concurrent redemptions cannot both win — which
 * matters because an authorization code is replayable until it is used.
 */
export async function consumeCode(code: string, clientId: string): Promise<OAuthCode | null> {
  const codeHash = await hashSecret('code', code)
  const { data, error } = await adminClient()
    .from('mcp_oauth_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code_hash', codeHash)
    .eq('client_id', clientId)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select()
    .maybeSingle()

  if (error || !data) return null
  return data as OAuthCode
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export async function createTokens(input: {
  clientId: string
  userId: string
  scope: string | null
  supabaseAccessToken: string
  supabaseRefreshToken: string
  supabaseExpiresAt: string | null
  accessTtlSeconds?: number
  refreshTtlSeconds?: number
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; refreshExpiresAt: string }> {
  const accessToken = randomSecret(32)
  const refreshToken = randomSecret(32)
  const now = new Date()
  const accessTtl = input.accessTtlSeconds ?? 3600
  const refreshTtl = input.refreshTtlSeconds ?? 60 * 60 * 24 * 30
  const expiresAt = new Date(now.getTime() + accessTtl * 1000)
  const refreshExpiresAt = new Date(now.getTime() + refreshTtl * 1000)

  const { error } = await adminClient().from('mcp_oauth_tokens').insert({
    token_hash: await hashSecret('access', accessToken),
    // Hashed under its own namespace so a leaked access-token row cannot be
    // replayed as a refresh token (and vice versa).
    refresh_token_hash: await hashSecret('refresh', refreshToken),
    client_id: input.clientId,
    user_id: input.userId,
    scope: input.scope,
    supabase_access_token: input.supabaseAccessToken,
    supabase_refresh_token: input.supabaseRefreshToken,
    supabase_expires_at: input.supabaseExpiresAt,
    expires_at: expiresAt.toISOString(),
    refresh_expires_at: refreshExpiresAt.toISOString(),
    last_used_at: now.toISOString(),
  })

  if (error) throw new Error(`Could not issue the access token: ${error.message}`)

  return { accessToken, refreshToken, expiresIn: accessTtl, refreshExpiresAt: refreshExpiresAt.toISOString() }
}

export async function getAccessToken(accessToken: string): Promise<OAuthToken | null> {
  const { data, error } = await adminClient()
    .from('mcp_oauth_tokens')
    .select('*')
    .eq('token_hash', await hashSecret('access', accessToken))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return data as OAuthToken
}

export async function getRefreshToken(refreshToken: string): Promise<OAuthToken | null> {
  const { data, error } = await adminClient()
    .from('mcp_oauth_tokens')
    .select('*')
    .eq('refresh_token_hash', await hashSecret('refresh', refreshToken))
    .gt('refresh_expires_at', new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return data as OAuthToken
}

/** Persist a refreshed Supabase session onto an existing MCP token row. */
export async function saveSupabaseSession(
  accessToken: string,
  session: { accessToken: string; refreshToken: string; expiresAt: string | null },
): Promise<void> {
  await adminClient()
    .from('mcp_oauth_tokens')
    .update({
      supabase_access_token: session.accessToken,
      supabase_refresh_token: session.refreshToken,
      supabase_expires_at: session.expiresAt,
      last_used_at: new Date().toISOString(),
    })
    .eq('token_hash', await hashSecret('access', accessToken))
}

export async function revokeToken(accessToken: string): Promise<void> {
  await revokeTokenByHash(await hashSecret('access', accessToken))
}

/**
 * Delete a token row when only its hash is at hand.
 *
 * Used when rotating on refresh: the previous row is identified by the hash we
 * already stored, so there is no need (and no way) to recover the token itself.
 */
export async function revokeTokenByHash(tokenHash: string): Promise<void> {
  await adminClient().from('mcp_oauth_tokens').delete().eq('token_hash', tokenHash)
}

/**
 * Drop every token issued to a user — the "I lost my device" button.
 *
 * Also what you would call after removing someone from the team: their
 * connector stops working everywhere at once rather than at each token's
 * expiry.
 */
export async function revokeAllForUser(userId: string): Promise<void> {
  await adminClient().from('mcp_oauth_tokens').delete().eq('user_id', userId)
}

/**
 * Best-effort sweep of used codes and long-expired tokens.
 *
 * The flow already deletes what it consumes; this only exists to clear rows
 * left behind by someone who closed the login tab halfway through. Never
 * throws — housekeeping must not take down an authorization request.
 */
export async function sweepExpired(): Promise<void> {
  const now = new Date().toISOString()
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  await Promise.all([
    adminClient().from('mcp_oauth_codes').delete().lt('expires_at', stale).then(
      () => undefined,
      () => undefined,
    ),
    adminClient().from('mcp_oauth_codes').delete().lt('consumed_at', now).then(
      () => undefined,
      () => undefined,
    ),
    adminClient().from('mcp_oauth_tokens').delete().lt('refresh_expires_at', now).then(
      () => undefined,
      () => undefined,
    ),
  ])
}
