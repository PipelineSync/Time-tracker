/**
 * GET /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource
 *
 * These two documents are how Claude discovers the connector. Claude fetches
 * the authorization-server metadata **first**, before it ever contacts /mcp, so
 * if these are wrong the connector will not connect at all.
 *
 * Both are served from one function because they differ only in a query
 * parameter, and Netlify's redirect rules point each well-known path here:
 *
 *   /.well-known/oauth-authorization-server            → this function
 *   /.well-known/oauth-protected-resource              → this function
 *   /.well-known/oauth-authorization-server/mcp        → this function (when
 *     the client resolves the resource metadata for /mcp and asks for the AS
 *     metadata at that path)
 */

import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  siteOrigin,
} from './lib/mcp/oauth'

// Served at both well-known paths by the rewrites in netlify.toml. Using
// rewrites rather than per-function `path` config keeps every connector route
// visible in one place, and a 200 rewrite preserves the request method — which
// matters for the POST-heavy /mcp and /oauth/token routes.

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Clients re-fetch this on every connection attempt; a cached copy would
      // pin them to an endpoint that may have moved.
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET' } })
  }

  const origin = siteOrigin(request)
  const path = new URL(request.url).pathname

  return json(
    path.includes('protected-resource')
      ? protectedResourceMetadata(origin)
      : authorizationServerMetadata(origin),
  )
}
