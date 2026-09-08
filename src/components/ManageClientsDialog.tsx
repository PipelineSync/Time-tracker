import { useEffect, useMemo, useState } from 'react'
import { Building2, Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useStore } from '@/lib/store'
import type { Client, ClientColor } from '@/lib/types'
import { CLIENT_COLORS, ClientColorStyles, DEFAULT_CLIENT_COLOR } from '@/lib/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

/** The eight colour tags, as a row of swatches. */
function ColorPicker({
  value,
  onChange,
  idPrefix,
}: {
  value: ClientColor
  onChange: (color: ClientColor) => void
  idPrefix: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CLIENT_COLORS.map((color) => (
        <button
          key={`${idPrefix}-${color}`}
          type="button"
          aria-label={`Use the ${color} tag`}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          className={cn(
            'h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition',
            ClientColorStyles[color].dot,
            value === color ? 'ring-2 ring-foreground/60' : 'opacity-60 hover:opacity-100'
          )}
        />
      ))}
    </div>
  )
}

/**
 * The admin's client master list: add a client, rename or re-colour one, and
 * mark it active/inactive at any time. Only ACTIVE clients are offered when
 * assigning a task or clocking in — retiring a client never touches the work
 * already tagged with it, which is why deleting is only allowed while a client
 * is unused.
 */
export function ManageClientsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { clients, tasks, entries, createClient, updateClient, deleteClient } = useStore()

  const [name, setName] = useState('')
  const [color, setColor] = useState<ClientColor>(DEFAULT_CLIENT_COLOR)
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState<ClientColor>(DEFAULT_CLIENT_COLOR)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Client | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setColor(DEFAULT_CLIENT_COLOR)
    setEditingId(null)
  }, [open])

  /** How much work each client carries — shown as a hint and gates deleting. */
  const usage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const t of tasks) if (t.client_id) counts.set(t.client_id, (counts.get(t.client_id) ?? 0) + 1)
    for (const e of entries) if (e.client_id) counts.set(e.client_id, (counts.get(e.client_id) ?? 0) + 1)
    return counts
  }, [tasks, entries])

  const activeCount = clients.filter((c) => c.status === 'active').length

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Give the client a name.')
      return
    }
    setAdding(true)
    try {
      const created = await createClient({ name: trimmed, color })
      if (!created) return
      toast.success(`${created.name} added.`)
      setName('')
      setColor(DEFAULT_CLIENT_COLOR)
    } finally {
      setAdding(false)
    }
  }

  function startEdit(client: Client) {
    setEditingId(client.id)
    setEditName(client.name)
    setEditColor(client.color)
  }

  async function saveEdit(client: Client) {
    const trimmed = editName.trim()
    if (!trimmed) {
      toast.error('Give the client a name.')
      return
    }
    setSavingId(client.id)
    try {
      const saved = await updateClient(client.id, { name: trimmed, color: editColor })
      if (saved) setEditingId(null)
    } finally {
      setSavingId(null)
    }
  }

  async function toggleStatus(client: Client, active: boolean) {
    setSavingId(client.id)
    try {
      const saved = await updateClient(client.id, { status: active ? 'active' : 'inactive' })
      if (saved) {
        toast.success(active ? `${saved.name} is active again.` : `${saved.name} marked inactive.`)
      }
    } finally {
      setSavingId(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Clients</DialogTitle>
            <DialogDescription>
              Your master list. Only <strong>active</strong> clients can be picked when assigning a task or
              clocking in — mark one inactive to retire it without touching the work already tagged with it.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={onAdd} className="grid gap-3 rounded-xl border bg-muted/40 p-3">
            <div className="grid gap-2">
              <Label htmlFor="client-name">Add a client</Label>
              <div className="flex gap-2">
                <Input
                  id="client-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Acme Corp"
                  maxLength={80}
                />
                <Button type="submit" disabled={adding} className="shrink-0">
                  <Plus className="mr-1.5 h-4 w-4" />
                  {adding ? 'Adding…' : 'Add'}
                </Button>
              </div>
            </div>
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">Colour tag</Label>
              <ColorPicker value={color} onChange={setColor} idPrefix="new" />
            </div>
          </form>

          <div className="max-h-[45vh] space-y-2 overflow-y-auto pr-0.5">
            {clients.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                <Building2 className="h-5 w-5" />
                No clients yet. Add your first one above — it shows up straight away when assigning tasks.
              </div>
            ) : (
              clients.map((client) => {
                const inUse = (usage.get(client.id) ?? 0) > 0
                const busy = savingId === client.id
                return (
                  <div
                    key={client.id}
                    className={cn(
                      'rounded-xl border p-3 transition',
                      client.status === 'inactive' && 'bg-muted/40'
                    )}
                  >
                    {editingId === client.id ? (
                      <div className="grid gap-3">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={80}
                          aria-label={`Rename ${client.name}`}
                          autoFocus
                        />
                        <ColorPicker value={editColor} onChange={setEditColor} idPrefix={client.id} />
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                            <X className="mr-1.5 h-3.5 w-3.5" /> Cancel
                          </Button>
                          <Button size="sm" disabled={busy} onClick={() => void saveEdit(client)}>
                            <Check className="mr-1.5 h-3.5 w-3.5" /> {busy ? 'Saving…' : 'Save'}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span
                          className={cn('h-3 w-3 shrink-0 rounded-full', ClientColorStyles[client.color].dot)}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <p className={cn('truncate text-sm font-medium', client.status === 'inactive' && 'text-muted-foreground')}>
                            {client.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {inUse ? `${usage.get(client.id)} task${usage.get(client.id) === 1 ? '' : 's'} / entries tagged` : 'Not used yet'}
                          </p>
                        </div>

                        <Badge variant={client.status === 'active' ? 'success' : 'muted'} className="text-[10px]">
                          {client.status === 'active' ? 'Active' : 'Inactive'}
                        </Badge>

                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={client.status === 'active'}
                            disabled={busy}
                            onCheckedChange={(v) => void toggleStatus(client, v)}
                            aria-label={`${client.status === 'active' ? 'Deactivate' : 'Activate'} ${client.name}`}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`Edit ${client.name}`}
                            onClick={() => startEdit(client)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive disabled:opacity-40"
                            aria-label={`Delete ${client.name}`}
                            title={inUse ? 'In use — mark it inactive instead' : 'Delete this client'}
                            disabled={inUse}
                            onClick={() => setDeleting(client)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {activeCount} active · {clients.length - activeCount} inactive
            </p>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="Delete this client?"
        description={deleting ? `"${deleting.name}" is not used by any task or time entry, so it can be removed for good.` : ''}
        onConfirm={async () => {
          if (deleting) await deleteClient(deleting.id)
          setDeleting(null)
        }}
      />
    </>
  )
}
