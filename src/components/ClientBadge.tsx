import type { Client } from '@/lib/types'
import { ClientColorStyles } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * A client's colour tag + name, used on kanban cards, time entries and the
 * clients list. Retired clients are dimmed and labelled so it is obvious why
 * they no longer appear in the dropdowns.
 */
export function ClientBadge({
  client,
  className,
  showInactive = true,
}: {
  client: Client | null | undefined
  className?: string
  /** Append "(inactive)" when the client has been retired. */
  showInactive?: boolean
}) {
  const style = client ? ClientColorStyles[client.color] : null
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        style ? style.badge : 'border-border bg-muted text-muted-foreground',
        client?.status === 'inactive' && 'opacity-70',
        className
      )}
      title={client ? client.name : 'No client'}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style ? style.dot : 'bg-muted-foreground/50')} aria-hidden />
      <span className="truncate">{client ? client.name : 'No client'}</span>
      {showInactive && client?.status === 'inactive' && <span className="shrink-0 opacity-80">(inactive)</span>}
    </span>
  )
}

/** Just the coloured dot — for tight spots like table rows. */
export function ClientDot({ client, className }: { client: Client | null | undefined; className?: string }) {
  const style = client ? ClientColorStyles[client.color] : null
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', style ? style.dot : 'bg-muted-foreground/40', className)}
      aria-hidden
    />
  )
}
