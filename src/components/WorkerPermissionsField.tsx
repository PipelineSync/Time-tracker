import { PERMISSION_GROUPS, PERMISSION_PRESETS, normalizePermissions, presetFor } from '@/lib/types'
import type { Permission, PermissionPreset } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ShieldCheck } from 'lucide-react'

const PRESET_ORDER: PermissionPreset[] = ['worker', 'supervisor', 'manager', 'full']

/**
 * The "Access" section of the add/edit worker form: which of the admin's
 * capabilities this worker gets. Everything is off by default — a worker with
 * no ticks sees only their own time and their own tasks, exactly as before.
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

  function toggle(permission: Permission, on: boolean) {
    const next = new Set(active)
    if (on) {
      next.add(permission)
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
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Access
        </Label>
        <p className="text-xs text-muted-foreground">
          Pick which of your admin capabilities this worker gets. With nothing ticked they only see their own
          time and their own tasks.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESET_ORDER.map((key) => {
          const p = PERMISSION_PRESETS[key]
          return (
            <Button
              key={key}
              type="button"
              size="sm"
              variant={preset === key ? 'default' : 'outline'}
              disabled={disabled}
              title={p.description}
              onClick={() => onChange([...p.permissions])}
            >
              {p.label}
            </Button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {preset ? PERMISSION_PRESETS[preset].description : `Custom — ${active.length} capabilities granted.`}
      </p>

      <div className="max-h-[38vh] space-y-2 overflow-y-auto pr-0.5">
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.key} className="rounded-xl border p-3">
            <div className="mb-2">
              <p className="text-sm font-medium">{group.label}</p>
              <p className="text-xs text-muted-foreground">{group.description}</p>
            </div>
            <div className="space-y-2">
              {group.items.map((item) => {
                const blocked = Boolean(item.requires && !active.includes(item.requires))
                const id = `perm-${item.key.replace('.', '-')}`
                return (
                  <div
                    key={item.key}
                    className={cn(
                      'flex items-start justify-between gap-3 rounded-lg px-1 py-1',
                      item.requires && 'pl-4'
                    )}
                  >
                    <div className="min-w-0">
                      <Label htmlFor={id} className={cn('text-sm font-normal', blocked && 'text-muted-foreground')}>
                        {item.label}
                      </Label>
                      <p className="text-xs text-muted-foreground">{item.hint}</p>
                    </div>
                    <Switch
                      id={id}
                      className="mt-0.5 shrink-0"
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
  )
}
