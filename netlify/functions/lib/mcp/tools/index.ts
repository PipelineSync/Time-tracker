/**
 * The connector's tool registry.
 *
 * Tools are grouped by area so a new capability lands next to the ones it
 * belongs with, and the registry itself stays a one-line change.
 */

import type { Caller } from '../session'
import { peopleTools } from './people'
import { timeTools } from './time'
import { taskTools } from './tasks'
import { moneyTools } from './money'
import { supportTools } from './support'

export type { Args } from '../args'

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface Tool {
  name: string
  title?: string
  description: string
  annotations: ToolAnnotations
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>
  handler: (caller: Caller, args: Record<string, unknown>) => Promise<unknown>
}

/** Every tool the connector exposes, in the order Claude sees them. */
export const TOOLS: Tool[] = [
  ...peopleTools,
  ...timeTools,
  ...taskTools,
  ...moneyTools,
  ...supportTools,
]

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name)
}
