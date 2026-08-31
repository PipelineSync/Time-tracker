import { useEffect, useState } from 'react'
import type { Worker } from '@/lib/types'
import { useStore } from '@/lib/store'
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
import { toast } from 'sonner'

export function WorkerFormDialog({
  open,
  onOpenChange,
  worker,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  worker: Worker | null
}) {
  const { createWorker, updateWorker, settings } = useStore()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [rate, setRate] = useState('')
  const [status, setStatus] = useState<'active' | 'inactive'>('active')
  const [accountEmail, setAccountEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(worker?.name || '')
      setEmail(worker?.email || '')
      setRate(String(worker?.hourly_rate ?? settings?.default_hourly_rate ?? 20))
      setStatus(worker?.status || 'active')
      setAccountEmail(worker?.email || '')
      setPassword('')
      setNewPassword('')
    }
  }, [open, worker, settings])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const parsedRate = parseFloat(rate)
    if (!name.trim()) {
      toast.error('Worker name is required.')
      return
    }
    if (isNaN(parsedRate) || parsedRate < 0) {
      toast.error('Hourly rate cannot be negative.')
      return
    }
    if (!worker && !accountEmail.trim()) {
      toast.error('A login email is required so the worker can sign in.')
      return
    }
    if (!worker && (!password || password.length < 6)) {
      toast.error('Set a password (at least 6 characters) for the worker.')
      return
    }
    setSaving(true)
    if (worker) {
      const res = await updateWorker(worker.id, {
        name: name.trim(),
        email: email.trim() || accountEmail.trim() || null,
        hourly_rate: parsedRate,
        status,
        newPassword: newPassword || undefined,
      })
      if (!res) toast.error('Failed to update worker.')
      else toast.success(newPassword ? 'Worker updated and password changed.' : 'Worker updated.')
    } else {
      const res = await createWorker({
        name: name.trim(),
        email: accountEmail.trim() || undefined,
        hourly_rate: parsedRate,
        status,
        accountEmail: accountEmail.trim(),
        accountPassword: password,
      })
      if (!res) toast.error('Failed to create worker.')
      else toast.success('Worker and login account created.')
    }
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{worker ? 'Edit worker' : 'Add worker'}</DialogTitle>
          <DialogDescription>
            {worker
              ? 'Update this worker. Fill "New password" only to reset their login.'
              : 'Create a worker and their login account so they can clock in.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="w-name">Name *</Label>
            <Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="John Smith" required />
          </div>

          {worker ? (
            <div className="space-y-2">
              <Label htmlFor="w-pw">New password (optional)</Label>
              <Input id="w-pw" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Leave blank to keep current" minLength={6} />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="w-account">Login email *</Label>
                <Input id="w-account" type="email" value={accountEmail} onChange={(e) => setAccountEmail(e.target.value)} placeholder="john@example.com" required />
                <p className="text-xs text-muted-foreground">The worker uses this to sign in.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="w-pw">Login password *</Label>
                <Input id="w-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" minLength={6} required />
                <p className="text-xs text-muted-foreground">Share this securely with the worker.</p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <Label htmlFor="w-rate">Hourly rate * <span className="font-normal text-muted-foreground">(admin-only)</span></Label>
            <Input id="w-rate" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="20.00" required />
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <div className="flex gap-2">
              <Button type="button" variant={status === 'active' ? 'default' : 'outline'} className="flex-1" onClick={() => setStatus('active')}>Active</Button>
              <Button type="button" variant={status === 'inactive' ? 'secondary' : 'outline'} className="flex-1" onClick={() => setStatus('inactive')}>Inactive</Button>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : worker ? 'Save changes' : 'Add worker'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
