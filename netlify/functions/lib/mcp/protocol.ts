/**
 * MCP (Model Context Protocol) JSON-RPC over Streamable HTTP.
 *
 * The connector is deliberately **stateless**: every POST is a complete
 * request that carries its own bearer token, so it runs on a serverless
 * function with no session affinity and no shared memory. That is the shape
 * the current MCP spec recommends for remote servers and the only one that
 * survives Netlify's per-request isolation.
 *
 * Supported, per the Streamable HTTP transport:
 *   POST   — client → server JSON-RPC (initialize, tools/list, tools/call …)
 *   GET    — not used for streaming here; answered 405 with a clear message
 *   DELETE — session termination; a no-op 200 because there is no session
 *   HEAD   — cheap liveness/protocol probe some hosts do before connecting
 */

import { findTool, TOOLS } from './tools'
import { AuthError, ToolError, type Caller } from './session'

/** The protocol versions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export const SERVER_INFO = { name: 'pipelinesync-work-tracker', version: '1.0.0' }

/** A JSON-RPC 2.0 request. `id` is absent for notifications. */
interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function result(id: string | number | null, payload: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, result: payload }
}

function error(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

export const PARSE_ERROR = -32700
export const INVALID_REQUEST = -32600
export const METHOD_NOT_FOUND = -32601
export const INVALID_PARAMS = -32602
export const INTERNAL_ERROR = -32603

/** Negotiate the protocol version the client asked for. */
function negotiate(requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
}

function toolPayload(tool: (typeof TOOLS)[number]) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }
}

/** Handle `initialize`. */
function handleInitialize(request: JsonRpcRequest, requestedVersion: unknown) {
  const clientInfo = (request.params?.clientInfo ?? {}) as { name?: string; version?: string }
  console.log(
    `[mcp] initialize from ${clientInfo.name ?? 'unknown client'} ${clientInfo.version ?? ''} ` +
      `wanting protocol ${String(requestedVersion)}`,
  )

  return result(request.id ?? null, {
    protocolVersion: negotiate(requestedVersion),
    capabilities: {
      tools: { listChanged: true },
    },
    serverInfo: SERVER_INFO,
    instructions:
      'Work Tracker holds this team\'s hours, tasks, payments, invoices and support tickets. ' +
      'Call whoami first if you are unsure what the connected account can see. ' +
      'Money is in the workspace currency shown by get_settings. ' +
      'Destructive tools (delete_*, settle_worker, clock_out) change real records — confirm intent with the user before calling them.',
  })
}

/** Handle a single JSON-RPC request. Returns null for notifications. */
async function handleRequest(
  request: JsonRpcRequest,
  callerFactory: () => Promise<Caller | null>,
  requestedVersion: unknown,
): Promise<Record<string, unknown> | null> {
  const method = request.method

  if (!method) return error(request.id ?? null, INVALID_REQUEST, 'Missing "method".')

  // Notifications: the client does not want a response body.
  if (method.startsWith('notifications/')) return null

  // Every method except notifications requires authentication.
  // Claude probes `initialize` without credentials to detect whether OAuth is
  // required (RFC 9728 §5.1): answering 401 here is what triggers the OAuth flow.
  const caller = (await callerFactory()) as Caller

  if (method === 'initialize') return handleInitialize(request, requestedVersion)
  if (method === 'ping') return result(request.id ?? null, {})

  if (method === 'tools/list') {
    return result(request.id ?? null, { tools: TOOLS.map(toolPayload) })
  }

  if (method === 'tools/call') {
    const params = request.params ?? {}
    const name = typeof params.name === 'string' ? params.name : ''
    const args = (params.arguments ?? {}) as Record<string, unknown>

    const tool = findTool(name)
    if (!tool) {
      return error(request.id ?? null, METHOD_NOT_FOUND, `Unknown tool "${name}".`, {
        available: TOOLS.map((t) => t.name),
      })
    }
    if (args !== null && (typeof args !== 'object' || Array.isArray(args))) {
      return error(request.id ?? null, INVALID_PARAMS, '"arguments" must be an object.')
    }

    const startedAt = Date.now()
    try {
      const output = await tool.handler(caller, args ?? {})
      console.log(`[mcp] ${tool.name} by ${caller.displayName} (${caller.role}) in ${Date.now() - startedAt}ms`)
      return result(request.id ?? null, {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output as Record<string, unknown>,
        isError: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The tool call failed.'
      // A permission or validation problem is a normal answer for the model to
      // read and react to; only genuine surprises are logged as errors.
      if (!(err instanceof ToolError)) {
        console.error(`[mcp] ${tool.name} failed:`, err)
      }
      return {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          content: [{ type: 'text', text: message }],
          isError: true,
        },
      }
    }
  }

  return error(request.id ?? null, METHOD_NOT_FOUND, `Method "${method}" is not supported by this server.`, {
    supported: ['initialize', 'ping', 'tools/list', 'tools/call'],
  })
}

/**
 * Process one Streamable HTTP POST body.
 *
 * Accepts a single request object or a JSON-RPC batch. A batch is normal for a
 * client that fires initialize + tools/list together, and returning an empty
 * body for an all-notifications batch is required by the spec.
 */
export async function handleJsonRpc(
  body: unknown,
  requestedVersion: unknown,
  callerFactory: () => Promise<Caller | null>,
): Promise<{ status: number; payload: unknown; authError?: AuthError }> {
  if (body === undefined || body === null) {
    return { status: 200, payload: null }
  }

  const batch = Array.isArray(body) ? body : [body]
  if (batch.length === 0) {
    return { status: 400, payload: error(null, INVALID_REQUEST, 'Empty batch.') }
  }

  const responses: Record<string, unknown>[] = []
  let authFailure: AuthError | null = null

  for (const entry of batch) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      responses.push(error(null, INVALID_REQUEST, 'Each batch entry must be a JSON-RPC object.'))
      continue
    }
    const request = entry as JsonRpcRequest
    if (request.jsonrpc !== '2.0') {
      responses.push(error(request.id ?? null, INVALID_REQUEST, 'Only JSON-RPC 2.0 is supported.'))
      continue
    }
    try {
      const response = await handleRequest(request, callerFactory, requestedVersion)
      if (response !== null) responses.push(response)
    } catch (err) {
      // Authentication failures are thrown, not returned, so the HTTP layer can
      // answer with a 401 carrying `WWW-Authenticate`. That header is the only
      // way an OAuth client learns where to send the user to sign in.
      if (err instanceof AuthError) {
        authFailure = err
        continue
      }
      if (err instanceof ToolError) {
        responses.push(error(request.id ?? null, INVALID_REQUEST, err.message))
        continue
      }
      console.error('[mcp] request failed:', err)
      responses.push(
        error(request.id ?? null, INTERNAL_ERROR, err instanceof Error ? err.message : 'Internal error.'),
      )
    }
  }

  // An unauthenticated batch has nothing useful to say in its body — the 401
  // and its WWW-Authenticate header are the whole answer.
  if (authFailure) return { status: 401, payload: null, authError: authFailure }

  if (responses.length === 0) return { status: 202, payload: null }

  return { status: 200, payload: Array.isArray(body) ? responses : responses[0] }
}
