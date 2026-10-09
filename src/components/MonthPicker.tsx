import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { addMonths, monthLabel } from '@/lib/finance'
import { cn } from '@/lib/utils'

interface MonthPickerProps {
  /** The month shown, 'YYYY-MM', or 'all' when the board has no month limit. */
  value: string
  /** This month, 'YYYY-MM'. Picking it again hands the board back to "this month". */
  current: string
  /** The months on offer, newest first. The shown month is added if it is not listed. */
  options: string[]
  /** Whether "All months" is offered. */
  allowAll?: boolean
  onChange: (value: string) => void
  /** Accessible name for the control group. */
  label: string
  className?: string
}

/**
 * A month chooser for the boards: step back and forward one month, jump to any
 * month on record, or go back to this month. The month totals above a board
 * cover the chosen month only, so each new month starts from zero.
 */
export function MonthPicker({ value, current, options, allowAll = false, onChange, label, className }: MonthPickerProps) {
  const listed = value !== 'all' && !options.includes(value) ? [value, ...options].sort().reverse() : options
  const isCurrent = value === current
  const canStep = value !== 'all'

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} role="group" aria-label={label}>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label="Previous month"
        disabled={!canStep}
        onClick={() => canStep && onChange(addMonths(value, -1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-[12.5rem]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowAll && <SelectItem value="all">All months</SelectItem>}
          {listed.map((ym) => (
            <SelectItem key={ym} value={ym}>
              {monthLabel(ym)}
              {ym === current ? ' · this month' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label="Next month"
        disabled={!canStep}
        onClick={() => canStep && onChange(addMonths(value, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      {!isCurrent && (
        <Button variant="outline" size="sm" className="h-9" onClick={() => onChange(current)}>
          This month
        </Button>
      )}
    </div>
  )
}
