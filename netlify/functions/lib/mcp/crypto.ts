/**
 * Small crypto helpers for the connector's OAuth 2.1 flow.
 *
 * Everything here runs on Web Crypto, which is global on Node 18+ (Netlify
 * runs Node 22 — see netlify.toml), so there are no native dependencies.
 */

const encoder = new TextEncoder()

/** URL-safe base64 of raw bytes (no padding). */
export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** URL-safe base64 of a UTF-8 string. */
export function base64UrlEncode(value: string): string {
  return base64Url(encoder.encode(value))
}

/** Decode URL-safe base64 (with or without padding) back to a string. */
export function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = atob(withPadding)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** A fresh high-entropy secret: client ids, codes, tokens. */
export function randomSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return base64Url(buffer)
}

/** SHA-256 of a string, as URL-safe base64 (the PKCE S256 transform). */
export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return base64Url(new Uint8Array(digest))
}

/**
 * Hash of a secret before it is stored.
 *
 * Codes and tokens are only ever kept hashed, so a dump of the table is not a
 * pile of usable credentials. The namespace stops a value from one column
 * (say a code) being replayed against another (say a token).
 */
export async function hashSecret(namespace: string, value: string): Promise<string> {
  return sha256Base64Url(`work-tracker:${namespace}:${value}`)
}

/** Constant-time string compare (length is not treated as secret here). */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge`.
 * Only S256 is supported — Claude always uses it, and `plain` is not secure
 * enough to be worth accepting.
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!verifier || verifier.length < 43 || verifier.length > 128) return false
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false
  return safeEqual(await sha256Base64Url(verifier), challenge)
}

/**
 * Read the `exp` claim out of a Supabase access token (a JWT).
 *
 * Used to refresh the session *before* it expires instead of discovering the
 * failure mid-query. Returns null when the token is opaque or malformed — the
 * caller then just tries the request and handles the error.
 */
export function jwtExpiry(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp : null
  } catch {
    return null
  }
}
