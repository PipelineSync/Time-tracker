import { useState } from 'react'
import { useStore } from '@/lib/store'
import { KeyRound, Eye, EyeOff, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export function WorkerLoginDetails({ workerId, onNavy = false }: { workerId: string; onNavy?: boolean }) {
  const { getWorkerLogin, backend } = useStore()
  const [login, setLogin] = useState<{ email: string | null; password: string | null } | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(false)

  async function load() {
    if (loading) return
    setLoading(true)
    const res = await getWorkerLogin(workerId)
    setLoading(false)
    if (!res) {
      toast.error('Could not load login details.')
      return
    }
    setLogin(res)
    setRevealed(true)
  }

  function toggle() {
    if (!login) {
      load()
    } else {
      setRevealed((r) => !r)
    }
  }

  const copy = (value: string, label: string) => {
    navigator.clipboard?.writeText(value).then(() => toast.success(`${label} copied.`)).catch(() => toast.error('Could not copy.'))
  }

  const isLocal = backend.kind === 'local'
  const email = login?.email ?? null
  const password = login?.password ?? null

  return (
    <div className={cn('rounded-lg p-3 text-sm', onNavy ? 'bg-white/10' : 'bg-muted/60')}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <KeyRound className="h-3.5 w-3.5" /> Login details
        </span>
        <button
          onClick={toggle}
          className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          disabled={loading}
        >
          {loading ? 'Loading…' : (
            revealed ? (<><EyeOff className="h-3.5 w-3.5" /> Hide</>) : (<><Eye className="h-3.5 w-3.5" /> Show</>)
          )}
        </button>
      </div>

      {revealed && login && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">Email</p>
              <p className="truncate font-mono text-xs">{email || '—'}</p>
            </div>
            {email && <button onClick={() => copy(email, 'Email')} className="text-muted-foreground hover:text-foreground" aria-label="Copy email"><Copy className="h-3.5 w-3.5" /></button>}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-muted-foreground">Password</p>
              <p className="truncate font-mono text-xs">{password ?? (isLocal ? '—' : 'Not retrievable')}</p>
            </div>
            {password && <button onClick={() => copy(password, 'Password')} className="text-muted-foreground hover:text-foreground" aria-label="Copy password"><Copy className="h-3.5 w-3.5" /></button>}
          </div>
          {!isLocal && !password && (
            <p className="text-[11px] text-muted-foreground">Passwords are hashed. Use “Password” to send a reset link.</p>
          )}
        </div>
      )}
    </div>
  )
}
