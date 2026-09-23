/**
 * POST /oauth/register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
 *
 * This is the step that makes the connector frictionless: Claude registers
 * itself the first time it connects, so there is no client id or secret for
 * anyone to copy out of a settings screen. The registered client is a **public
 * client** (`token_endpoint_auth_method: none`) that authenticates with PKCE,
 * which is the only safe shape for an app that cannot keep a secret.
 *
 * Nothing here is gated: registration is not an authorization. A client cannot
 * read a single row until a real user signs in at /oauth/authorize.
 */

import { createClient } from './lib/mcp/oauth-store'
import { oauthError, validateRedirectUris } from './lib/mcp/oauth'

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } })
  }

  // Read the body once: a Request's body can only be consumed a single time,
  // so both the flat fields and the structured `redirect_uris` array have to
  // come from the same read.
  let text = ''
  try {
    text = await request.text()
  } catch {
    return oauthError(400, 'invalid_request', 'Could not read the registration request.')
  }

  const body: Record<string, string> = {}
  let rawUris: unknown = undefined

  if (text.trim().startsWith('{')) {
    const parsed = JSON.parse(text) as Record<string, unknown>
    rawUris = parsed.redirect_uris
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        body[key] = String(value)
      }
    }
  } else {
    for (const [key, value] of new URLSearchParams(text)) body[key] = value
  }

  // Fall back to the repeated `redirect_uri` / `redirect_uris` form fields that
  // some clients send instead of a JSON array.
  if (rawUris === undefined) {
    const single = body.redirect_uri
    const many = body.redirect_uris
    rawUris = many ? many.split(/[\s,]+/).filter(Boolean) : single ? [single] : undefined
  }

  const validated = validateRedirectUris(rawUris)
  if (!validated.ok) return oauthError(400, 'invalid_redirect_uri', validated.error)

  const grantTypes = body.grant_types
    ? body.grant_types.split(/[\s,]+/).filter(Boolean)
    : ['authorization_code', 'refresh_token']
  if (!grantTypes.includes('authorization_code')) {
    return oauthError(400, 'invalid_client_metadata', 'grant_types must include "authorization_code".')
  }

  try {
    const { clientId } = await createClient({
      redirectUris: validated.uris,
      name: typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null,
      grantTypes,
      scope: 'worktracker.read worktracker.write',
    })

    return new Response(
      JSON.stringify({
        client_id: clientId,
        redirect_uris: validated.uris,
        grant_types: grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        client_name: body.client_name ?? 'Claude',
        // Optional in RFC 7591 and omitted here: a public client has no secret,
        // and inventing one would only invite someone to treat it as security.
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      },
    )
  } catch (error) {
    console.error('[mcp-oauth] registration failed:', error)
    return oauthError(500, 'server_error', 'Could not register the client. Check the connector setup.')
  }
}
