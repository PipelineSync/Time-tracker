import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, Send } from 'lucide-react'
import { sendSlackTestMessage } from '@/lib/slack'
import { isSupabaseConfigured } from '@/lib/supabaseDb'
import type { SlackSettings } from '@/lib/types'
import { DEFAULT_SLACK_SETTINGS } from '@/lib/types'

// Settings → Slack. Admin-only card that configures the Slack incoming
// webhook and which events mirror into the channel: clock in / clock out /
// break start / back from break / payment paid.
export function SlackSettingsCard() {
  const { getSlackSettings, saveSlackSettings } = useStore()
  const [webhookUrl, setWebhookUrl] = useState('')
  const [toggles, setToggles] = useState<SlackSettings>({ ...DEFAULT_SLACK_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    let alive = true
    getSlackSettings().then((s) => {
      if (!alive) return
      const cfg = s ?? { ...DEFAULT_SLACK_SETTINGS }
      setToggles(cfg)
      setWebhookUrl(cfg.webhook_url || '')
      setLoading(false)
    })
    return () => { alive = false }
  }, [getSlackSettings])

  function setToggle(key: keyof Pick<SlackSettings, 'notify_clock_in' | 'notify_clock_out' | 'notify_break_start' | 'notify_break_end' | 'notify_payment_paid'>, value: boolean) {
    setToggles((prev) => ({ ...prev, [key]: value }))
  }

  async function persist(): Promise<boolean> {
    setSaving(true)
    const next = await saveSlackSettings({
      webhook_url: webhookUrl.trim() || null,
      notify_clock_in: toggles.notify_clock_in,
      notify_clock_out: toggles.notify_clock_out,
      notify_break_start: toggles.notify_break_start,
      notify_break_end: toggles.notify_break_end,
      notify_payment_paid: toggles.notify_payment_paid,
    })
    setSaving(false)
    if (!next) return false
    setToggles(next)
    setWebhookUrl(next.webhook_url || '')
    return true
  }

  async function onSave() {
    if (await persist()) toast.success('Slack settings saved.')
  }

  async function onTest() {
    if (!(await persist())) return
    setTesting(true)
    const err = await sendSlackTestMessage()
    setTesting(false)
    if (err) toast.error(err)
    else toast.success('Test message sent — check your Slack channel.')
  }

  const toggleRows: Array<{ key: Parameters<typeof setToggle>[0]; label: string }> = [
    { key: 'notify_clock_in', label: 'Clock in' },
    { key: 'notify_clock_out', label: 'Clock out' },
    { key: 'notify_break_start', label: 'Break started' },
    { key: 'notify_break_end', label: 'Back from break' },
    { key: 'notify_payment_paid', label: 'Payment paid' },
  ]

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Slack notifications</CardTitle>
          <Badge variant="secondary">Automation</Badge>
        </div>
        <CardDescription>
          Post to a Slack channel automatically when someone clocks in, clocks out, takes a break, or when you mark a payment as paid.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading Slack settings…
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="s-slack-webhook">Slack webhook URL</Label>
              <Input
                id="s-slack-webhook"
                type="url"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/T000/B000/XXXX"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                In Slack: <strong>Create an app</strong> → <strong>From scratch</strong> → pick your workspace → turn on{' '}
                <strong>Incoming Webhooks</strong> → <strong>Add New Webhook to Workspace</strong> and choose the channel — then paste the{' '}
                <code>https://hooks.slack.com/services/…</code> URL here.{' '}
                <a
                  href="https://api.slack.com/messaging/webhooks"
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Slack&rsquo;s guide ↗
                </a>
                {isSupabaseConfigured() && ' Leave empty to fall back to a SLACK_WEBHOOK_URL environment variable, if your deploy sets one.'}
              </p>
            </div>

            <div className="space-y-2">
              <Label>Send a message when…</Label>
              <div className="divide-y rounded-md border">
                {toggleRows.map((row) => (
                  <label key={row.key} className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <span className="text-sm">{row.label}</span>
                    <Switch checked={toggles[row.key]} onCheckedChange={(v) => setToggle(row.key, v)} />
                  </label>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={onSave} disabled={saving}>
                {saving && <Loader2 className="animate-spin" />} Save
              </Button>
              <Button variant="outline" onClick={onTest} disabled={saving || testing}>
                {testing ? <Loader2 className="animate-spin" /> : <Send />} Send test message
              </Button>
            </div>

            {!isSupabaseConfigured() && (
              <p className="text-xs text-muted-foreground">
                Demo mode: with no server connected, messages are posted straight from this browser using the webhook URL above.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
