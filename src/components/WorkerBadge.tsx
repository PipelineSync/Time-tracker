import { useRef } from 'react'
import type { Worker } from '@/lib/types'
import {
  WORKER_COLORS,
  WORKER_COLOR_NAMES,
  ClientColorStyles,
  isWorkerColorPreset,
  isValidWorkerColor,
  workerColorStyles,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'

/** Just the coloured dot for a worker. */
export function WorkerDot({
  color,
  className,
}: {
  color: string | null | undefined
  className?: string
}) {
  const style = workerColorStyles(color)
  if (!style) return null
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', style.dot, className)}
      style={style.dotStyle}
      aria-hidden="true"
    />
  )
}

/** A worker's colour tag badge (dot + label) mirroring ClientBadge. */
export function WorkerBadge({
  worker,
  color,
  className,
}: {
  worker?: Worker | null
  color?: string | null
  className?: string
}) {
  const c = color ?? worker?.color
  const style = workerColorStyles(c)
  if (!style || !c) return null
  const label = isWorkerColorPreset(c) ? WORKER_COLOR_NAMES[c] : c

  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        style.badge,
        className
      )}
      style={style.badgeStyle}
      title={`Colour tag: ${label}`}
    >
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', style.dot)}
        style={style.dotStyle}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </span>
  )
}

/** Colour picker for worker add/edit, identical vocabulary to client colour tags. */
export function WorkerColorPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: string | null
  onChange: (color: string | null) => void
  idPrefix: string
}) {
  const customInputRef = useRef<HTMLInputElement>(null)
  const isCustom = Boolean(value && !isWorkerColorPreset(value) && isValidWorkerColor(value))
  const custom = isCustom ? workerColorStyles(value) : null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* None / Unset button */}
      <button
        key={`${idPrefix}-none`}
        type="button"
        aria-label="No colour tag"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full border border-border text-[11px] font-medium text-muted-foreground ring-offset-2 ring-offset-background transition',
          value === null ? 'border-foreground/60 ring-2 ring-foreground/60' : 'opacity-60 hover:opacity-100'
        )}
        title="No colour tag"
      >
        <span className="leading-none">/</span>
      </button>

      {/* 8 Built-in tag presets */}
      {WORKER_COLORS.map((c) => {
        const isSelected = value === c
        return (
          <button
            key={`${idPrefix}-${c}`}
            type="button"
            aria-label={`Use the ${c} tag`}
            aria-pressed={isSelected}
            onClick={() => onChange(isSelected ? null : c)}
            className={cn(
              'h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition',
              ClientColorStyles[c].dot,
              isSelected ? 'ring-2 ring-foreground/60' : 'opacity-60 hover:opacity-100'
            )}
            title={WORKER_COLOR_NAMES[c]}
          />
        )
      })}

      {/* Custom colour button */}
      <button
        key={`${idPrefix}-custom`}
        type="button"
        aria-label={isCustom ? `Custom colour ${value} — pick another` : 'Pick a custom colour'}
        aria-pressed={isCustom}
        onClick={() => customInputRef.current?.click()}
        className={cn(
          'relative h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition',
          isCustom ? 'ring-2 ring-foreground/60' : 'opacity-60 hover:opacity-100'
        )}
        style={
          isCustom && custom
            ? custom.dotStyle
            : { background: 'conic-gradient(from 220deg, #f43f5e, #f77a0a, #f59e0b, #10b981, #36b7c9, #0868d9, #8b5cf6, #f43f5e)' }
        }
        title={isCustom ? `Custom colour ${value}` : 'Pick a custom colour'}
      >
        {isCustom && <Check className="pointer-events-none absolute inset-0 m-auto h-3.5 w-3.5 text-white" aria-hidden />}
      </button>
      <input
        ref={customInputRef}
        type="color"
        value={isCustom && custom ? custom.chart : '#8b5cf6'}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />
    </div>
  )
}
