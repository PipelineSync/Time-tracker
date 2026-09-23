/**
 * Tool result formatting.
 *
 * Claude reads tool output as text, so results are compact JSON. Two rules
 * keep responses inside the connector's size limits and inside the model's
 * useful attention span:
 *
 *   - Rows are projected down to the columns that answer the question. A
 *     `tasks` row carries ~25 columns of KPI bookkeeping that would drown out
 *     the three fields Claude asked for.
 *   - Every list is capped and says when it was truncated, so the model knows
 *     to narrow the query rather than believing it saw everything.
 */

import type { Caller } from './session'

/** The tools' shared "here are your rows" envelope. */
export interface ListResult {
  count: number
  /** Present when the query matched more rows than were returned. */
  truncated?: boolean
  /** A hint that helps Claude refine the next call. */
  hint?: string
  rows: unknown[]
}

export function list(rows: unknown[], opts: { limit: number; hint?: string }): ListResult {
  const capped = rows.slice(0, opts.limit)
  const result: ListResult = { count: capped.length, rows: capped }
  if (rows.length > capped.length) {
    result.truncated = true
    result.hint = opts.hint ?? 'Narrow the date range or filters to see the rest.'
  }
  return result
}

export function ok(message: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, message, ...extra }
}

/**
 * Resolve worker ids to names so results read like the app.
 *
 * A worker id is what the database joins on, but Claude (and the person
 * reading its answer) needs "Ana", not a UUID. Worker ids also appear in
 * entries, tasks, payments and finance rows, so this is used everywhere.
 */
export async function workerNames(
  caller: Caller,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, string>()
  if (unique.length === 0) return map

  const { data } = await caller.sb.from('workers').select('id, name').in('id', unique)
  for (const row of (data ?? []) as { id: string; name: string }[]) {
    map.set(row.id, row.name)
  }
  // A worker the caller cannot see (RLS filtered the row) still gets a stable
  // placeholder, so the shape of the result never surprises the model.
  for (const id of unique) if (!map.has(id)) map.set(id, 'Unknown worker')
  return map
}

export async function clientNames(
  caller: Caller,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const map = new Map<string, string>()
  if (unique.length === 0) return map
  const { data } = await caller.sb.from('clients').select('id, name').in('id', unique)
  for (const row of (data ?? []) as { id: string; name: string }[]) map.set(row.id, row.name)
  for (const id of unique) if (!map.has(id)) map.set(id, 'Unknown client')
  return map
}

/** Human hours, rounded the way the app displays them. */
export function hours(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100
}

export function money(amount: number): number {
  return Math.round(Number(amount ?? 0) * 100) / 100
}
