import { useEffect, useState } from 'react'
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
import { KeyRound, Loader2, Mail } from 'lucide-react'
import type { Worker } from '@/lib/types'

export function ResetWorkerPasswordDialog({
  worker,
  open,
  onOpenChange,
}: {
  worker: Worker
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { backend, resetWorkerPassword } = useStore()
  const isLocal = backend.kind === 'local'
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setPassword('')
      setConfirm('')
    }
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isLocal) {
      if (password.length < 6) {
        toast.error('New password must be at least 6 characters.')
        return
      }
      if (password !== confirm) {
        toast.error('Passwords do not match.')
        return
      }
    }
    setSaving(true)
    const err = await resetWorkerPassword(worker.id, password)
    setSaving(false)
    if (err) {
      toast.error(err)
      return
    }
    toast.success(isLocal ? `Password reset for ${worker.name}.` : `Password reset email sent to ${worker.email || 'the worker'}.`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-primary" /> Reset password — {worker.name}
          </DialogTitle>
          <DialogDescription>
            {isLocal
              ? 'Set a new password for this worker’s login account.'
              : 'A password reset link will be emailed to the worker to set a new password.'}
          </DialogDescription>
        </DialogHeader>
        {isLocal ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rw-new">New password</Label>
              <Input id="rw-new" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={6} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rw-confirm">Confirm new password</Label>
              <Input id="rw-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={6} required />
            </div>
            <DialogFooter className="gap-2 sm:justify-end">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Reset password
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-lg bg-muted p-4 text-sm">
              <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">Send reset link</p>
                <p className="text-xs text-muted-foreground">
                  We’ll email a password reset link to <span className="font-mono">{worker.email || '(no email on file)'}</span>. The worker
                  sets their own new password from that link.
                </p>
              </div>
            </div>
            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Send reset email
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
