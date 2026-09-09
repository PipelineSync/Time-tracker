import { useEffect, useRef, useState } from 'react'
import { PERMISSION_GROUPS, PERMISSION_PRESETS, normalizePermissions, presetFor } from '@/lib/types'
import type { Permission } from '@/lib/types'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ChevronDown, ShieldCheck } from 'lucide-react'

/**
 * The "Access" section of the add/edit worker form: which of the admin's
 * capabilities this worker gets. Everything is off by default — a worker with
 * no ticks sees only their own time and their own tasks, exactly as before.
 *
 * It is collapsed to a one-line summary unless the worker actually has extra
 * access, so adding a plain worker stays a short form. There is deliberately
 * no scroll area inside it: the dialog body is the only thing that scrolls.
 */
export function WorkerPermissionsField({
  value,
  onChange,
  disabled,
}: {
  value: Permission[]
  onChange: (next: Permission[]) => void
  disabled?: boolean
}) {
  const active = normalizePermissions(value)
  const preset = presetFor(active)
  const [open, setOpen] = useState(false)

  // Open on its own when the worker being edited already has access granted,
  // so it is never hidden away. (The parent seeds the form after mount, hence
  // the effect rather than a lazy initial state.)
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!autoOpened.current && active.length > 0) {
      autoOpened.current = true
      setOpen(true)
    }
  }, [active.length])

  const summary = preset
    ? `${PERMISSION_PRESETS[preset].label} — ${PERMISSION_PRESETS[preset].description}`
    : `Custom — ${active.length} ${active.length === 1 ? 'capability' : 'capabilities'} granted.`

  function toggle(permission: Permission, on: boolean) {
    const next = new Set(active)
    if (on) {
      next.add(permission)
      // If toggling finance.subscription, disable finance.payroll and vice versa
      const perm = permission as string
      if (perm === 'finance.subscription') {
        next.delete('finance.payroll')
      } else if (perm === 'finance.payroll') {
        next.delete('finance.subscription')
      }
      // Granting a "manage" capability implies being able to see the area.
      for (const group of PERMISSION_GROUPS) {
        for (const item of group.items) {
          if (item.key === permission && item.requires) next.add(item.requires)
        }
      }
    } else {
      next.delete(permission)
      // Taking the view away takes the actions that depend on it away too.
      for (const group of PERMISSION_GROUPS) {
        for (const item of group.items) {
          if (item.requires === permission) next.delete(item.key)
        }
      }
    }
    onChange(normalizePermissions([...next]))
  }

  return (
    <div className="rounded-xl border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Access
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-3 border-t p-3">
          <div className="space-y-2">
            {PERMISSION_GROUPS.map((group) => (
              <div key={group.key} className="rounded-lg border p-2.5">
                <p className="text-sm font-medium leading-none">{group.label}</p>
                <div className="mt-2 space-y-1.5">
                  {group.items.map((item) => {
                    const blocked = Boolean(item.requires && !active.includes(item.requires))
                    const id = `perm-${item.key.replace('.', '-')}`
                    return (
                      <div
                        key={item.key}
                        className={cn('flex items-center justify-between gap-3', item.requires && 'pl-4')}
                      >
                        <Label
                          htmlFor={id}
                          title={item.hint}
                          className={cn('text-[13px] font-normal leading-snug', blocked && 'text-muted-foreground')}
                        >
                          {item.label}
                        </Label>
                        <Switch
                          id={id}
                          className="shrink-0"
                          checked={active.includes(item.key)}
                          disabled={disabled || blocked}
                          onCheckedChange={(on) => toggle(item.key, on)}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
