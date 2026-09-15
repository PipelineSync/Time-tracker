import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  leading,
  children,
}: {
  title: string
  description?: string
  /**
   * Optional control pinned to the **upper-left** of the heading, aligned with
   * the title's first line — the slot the FAQ button uses (see `FaqButton`).
   */
  leading?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        {/* pt-1 / sm:pt-1.5 centre the slot on the title's line box at both
            heading sizes (text-2xl and sm:text-3xl). */}
        {leading && <div className="pt-1 sm:pt-1.5">{leading}</div>}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {/* empty:hidden: a slot whose content renders nothing must not leave a
          gap behind — and a caller that hides its own child gets no stray row. */}
      {children && <div className="flex flex-wrap items-center gap-2 empty:hidden">{children}</div>}
    </div>
  )
}
