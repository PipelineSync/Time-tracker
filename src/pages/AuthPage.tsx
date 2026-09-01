import { useState } from 'react'
import { useStore } from '@/lib/store'
import { isSupabaseConfigured } from '@/lib/supabaseDb'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BrandLogo } from '@/components/BrandLogo'
import { toast } from 'sonner'
import { Loader2, ShieldCheck, Eye, EyeOff, TriangleAlert, Database } from 'lucide-react'

const supabaseReady = isSupabaseConfigured()

export function AuthPage() {
  const { signIn, resetPassword } = useStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sendingReset, setSendingReset] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const err = await signIn(email, password)
    setLoading(false)
    if (err) toast.error(err)
  }

  async function handleForgotPassword() {
    const trimmed = email.trim()
    if (!trimmed) {
      toast.error('Type your email in the field above, then click "Forgot password?".')
      return
    }
    setSendingReset(true)
    const err = await resetPassword(trimmed)
    setSendingReset(false)
    if (err) toast.error(err)
    else toast.success(`Password reset email sent to ${trimmed} — check your inbox (and spam folder).`)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center space-y-3 text-center">
          <BrandLogo className="h-9" />
          <p className="max-w-xs text-sm text-muted-foreground">
            Clean time tracking for your team.
          </p>
        </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" /> Sign in
              </CardTitle>
              <CardDescription>
                Sign in with the credentials provided to you.
              </CardDescription>
              {supabaseReady ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Database className="h-3.5 w-3.5" /> Connected to Supabase — sign in with your account email.
                </p>
              ) : (
                <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong>Demo mode.</strong> Supabase environment variables were missing when this site was
                    built, so logins are stored only in this browser. Set{' '}
                    <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
                    <code className="font-mono">VITE_SUPABASE_PUBLISHABLE_KEY</code> in your host's environment
                    variables, then redeploy.
                  </span>
                </p>
              )}
            </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{supabaseReady ? 'Email' : 'Username / email'}</Label>
                <Input id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={supabaseReady ? 'you@example.com' : 'admin or you@example.com'} autoComplete="username" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(e) => setShowPassword(e.target.checked)}
                    className="h-4 w-4 rounded border-border accent-[#0868D9]"
                  />
                  Show password
                </label>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="animate-spin" />} Sign in
              </Button>
              {supabaseReady && (
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={sendingReset}
                  className="w-full text-center text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
                >
                  {sendingReset ? 'Sending reset email…' : 'Forgot password?'}
                </button>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}


