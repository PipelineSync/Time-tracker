import { useEffect, useState } from 'react'
import { useStore } from '@/lib/store'
import { useTheme } from '@/lib/theme'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { toast } from 'sonner'
import { Sun, Moon, Monitor, Download, Trash2, Loader2 } from 'lucide-react'

export function SettingsPage() {
  const { settings, saveSettings, resetAllData, workers, entries, backend, user, isAdmin } = useStore()
  const { theme, setTheme } = useTheme()
  const [businessName, setBusinessName] = useState(settings?.business_name || '')
  const [currency, setCurrency] = useState(settings?.currency || 'USD')
  const [timezone, setTimezone] = useState(settings?.timezone || '')
  const [defaultRate, setDefaultRate] = useState(String(settings?.default_hourly_rate ?? 20))
  const [saving, setSaving] = useState(false)
  const [avatar, setAvatar] = useState(settings?.avatar_url || '')
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    if (settings) {
      setBusinessName(settings.business_name)
      setCurrency(settings.currency)
      setTimezone(settings.timezone)
      setDefaultRate(String(settings.default_hourly_rate ?? 20))
      setAvatar(settings.avatar_url || '')
    }
  }, [settings])

  const CURRENCIES = ['USD', 'EUR', 'GBP', 'PHP', 'CAD', 'AUD', 'JPY', 'INR']

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const rate = parseFloat(defaultRate)
    if (isNaN(rate) || rate < 0) {
      toast.error('Default hourly rate cannot be negative.')
      return
    }
    setSaving(true)
    const res = await saveSettings({
      business_name: businessName.trim() || 'My Business',
      currency: currency || 'USD',
      timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      default_hourly_rate: rate,
      avatar_url: avatar || null,
    })
    setSaving(false)
    if (!res) toast.error('Failed to save settings.')
    else toast.success('Settings saved.')
  }

  function exportAll() {
    const data = {
      exportedAt: new Date().toISOString(),
      workers,
      timeEntries: entries,
      settings,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'work-tracker-backup.json'
    a.click()
    URL.revokeObjectURL(url)
    toast.success('All data exported.')
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Manage your workspace preferences." />

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>General</CardTitle>
              <CardDescription>Business details and default preferences.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSave} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="s-avatar">Profile picture</Label>
                  <div className="flex items-center gap-3">
                    {avatar ? <img src={avatar} alt="Profile" className="h-12 w-12 rounded-full object-cover" /> : <div className="h-12 w-12 rounded-full bg-muted" />}
                    <Input id="s-avatar" type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (file) { const reader = new FileReader(); reader.onload = () => setAvatar(String(reader.result)); reader.readAsDataURL(file) } }} />
                  </div>
                  <p className="text-xs text-muted-foreground">Upload a picture to personalize your account.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s-name">Company / business name</Label>
                  <Input id="s-name" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="My Business" />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="s-currency">Currency</Label>
                    <select id="s-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                      {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s-tz">Time zone</Label>
                    <Input id="s-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="s-rate">Default hourly rate</Label>
                  <Input id="s-rate" type="number" min="0" step="0.01" value={defaultRate} onChange={(e) => setDefaultRate(e.target.value)} className="max-w-[200px]" />
                </div>
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="animate-spin" />} Save settings
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="appearance" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Choose how the app looks.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                {([
                  { id: 'light', label: 'Light mode', icon: Sun },
                  { id: 'dark', label: 'Dark mode', icon: Moon },
                  { id: 'system', label: 'System theme', icon: Monitor },
                ] as const).map((o) => (
                  <button
                    key={o.id}
                    onClick={() => setTheme(o.id)}
                    className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors ${theme === o.id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                  >
                    <o.icon className="h-6 w-6" />
                    <span className="text-sm font-medium">{o.label}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="data" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Data</CardTitle>
              <CardDescription>Export or delete all of your data.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">Export all data</p>
                  <p className="text-sm text-muted-foreground">Download a JSON backup of your workers and time entries.</p>
                </div>
                <Button variant="outline" onClick={exportAll}><Download className="mr-1 h-4 w-4" /> Export</Button>
              </div>
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium text-destructive">Delete all data</p>
                  <p className="text-sm text-muted-foreground">Permanently remove all workers and time entries. This cannot be undone.</p>
                </div>
                <Button variant="destructive" onClick={() => setConfirmReset(true)}><Trash2 className="mr-1 h-4 w-4" /> Delete all</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Delete all data?"
        description="This will permanently delete all workers and time entries for your account. This cannot be undone."
        confirmLabel="Delete everything"
        onConfirm={async () => {
          setResetting(true)
          await resetAllData()
          setResetting(false)
          toast.success('All data deleted.')
        }}
      />
    </div>
  )
}
