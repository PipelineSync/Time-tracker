import { useMemo } from 'react'
import { useStore } from '@/lib/store'
import { ClientColorStyles } from '@/lib/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/**
 * Pick a client. Only ACTIVE clients are offered, because inactive ones are
 * retired from new work — except the value already on the row being edited,
 * which stays in the list so opening an old task cannot silently re-tag it.
 *
 * With `includeAll` it doubles as the filter control on the Tasks and Entries
 * pages, where the extra "All clients" option maps to the value `all`.
 */
export function ClientSelect({
  value,
  onValueChange,
  id,
  /** Accessible name for the trigger, for filter-style uses with no visible label. */
  ariaLabel,
  includeAll = false,
  allLabel = 'All clients',
  placeholder = 'Choose a client',
  disabled = false,
  /** A client to hide from the options (e.g. the one already in use). */
  excludeId,
  className,
}: {
  value: string
  onValueChange: (value: string) => void
  id?: string
  ariaLabel?: string
  includeAll?: boolean
  allLabel?: string
  placeholder?: string
  disabled?: boolean
  excludeId?: string
  className?: string
}) {
  const { clients, activeClients } = useStore()

  const options = useMemo(() => {
    let list = [...activeClients]
    if (excludeId) list = list.filter((c) => c.id !== excludeId)
    // Keep the current selection visible even after it has been retired.
    const current = clients.find((c) => c.id === value)
    if (current && current.status === 'inactive') list.push(current)
    return list
  }, [activeClients, clients, value, excludeId])

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value="all">{allLabel}</SelectItem>}
        {options.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="flex items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', ClientColorStyles[c.color].dot)} aria-hidden />
              <span className="truncate">{c.name}</span>
              {c.status === 'inactive' && <span className="text-xs text-muted-foreground">(inactive)</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
