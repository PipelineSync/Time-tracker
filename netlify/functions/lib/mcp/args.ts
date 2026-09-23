/**
 * Argument coercion for MCP tool inputs.
 *
 * Claude passes whatever the JSON Schema allowed, but a model can still send
 * `"limit": "50"` or a date as `"2026-09-01"` when the schema said string.
 * Everything is therefore coerced defensively and unknown values are dropped
 * rather than turned into `undefined`-poisoned Supabase filters.
 */

import { ToolError } from './session'

export type Args = Record<string, unknown>

export function str(args: Args, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function num(args: Args, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function bool(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** A bounded page size. Never let a model ask for 10,000 rows. */
export function limit(args: Args, key = 'limit', fallback = 50, max = 200): number {
  const value = num(args, key)
  if (value === undefined) return fallback
  return Math.max(1, Math.min(max, Math.floor(value)))
}

/**
 * A UUID, or null.
 *
 * Worker/client ids are UUIDs; accepting a free string would let a malformed
 * value reach Postgres and surface as a raw driver error to Claude.
 */
export function uuid(args: Args, key: string): string | undefined {
  const value = str(args, key)
  if (!value) return undefined
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ToolError(`"${key}" must be an id copied from another Work Tracker result, not a name.`)
  }
  return value
}

/** A YYYY-MM-DD calendar date (the shape due_date and period_month use). */
export function dateOnly(args: Args, key: string): string | undefined {
  const value = str(args, key)
  if (!value) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ToolError(`"${key}" must be a date in YYYY-MM-DD format, e.g. 2026-09-24.`)
  }
  return value
}

/** A YYYY-MM month. */
export function monthOnly(args: Args, key: string): string | undefined {
  const value = str(args, key)
  if (!value) return undefined
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new ToolError(`"${key}" must be a month in YYYY-MM format, e.g. 2026-09.`)
  }
  return value
}

/**
 * An ISO timestamp.
 *
 * Bare dates (`2026-09-01`) are accepted and expanded to the start of that day
 * in the workspace timezone's day — we use UTC midnight, which is what the
 * rest of the app compares against.
 */
export function timestamp(args: Args, key: string): string | undefined {
  const value = str(args, key)
  if (!value) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    if (Number.isNaN(parsed.getTime())) throw new ToolError(`"${key}" is not a valid date.`)
    return parsed.toISOString()
  }
  // End-of-day convenience: `2026-09-30` given as `to` should include that day.
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new ToolError(`"${key}" is not a valid date/time.`)
  return parsed.toISOString()
}

/** `to` bounds are inclusive-of-day: a bare date means the end of that day. */
export function timestampEnd(args: Args, key: string): string | undefined {
  const raw = str(args, key)
  if (!raw) return undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T23:59:59.999Z`)
    if (Number.isNaN(parsed.getTime())) throw new ToolError(`"${key}" is not a valid date.`)
    return parsed.toISOString()
  }
  return timestamp(args, key)
}

/** One of a fixed set of values, or undefined. */
export function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const value = str(args, key)
  if (value === undefined) return undefined
  const match = allowed.find((option) => option === value)
  if (!match) {
    throw new ToolError(`"${key}" must be one of: ${allowed.join(', ')}.`)
  }
  return match
}

/** Pick only the keys a caller actually supplied, for partial updates. */
export function pick(args: Args, keys: readonly string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const key of keys) {
    if (args[key] !== undefined) patch[key] = args[key]
  }
  return patch
}
