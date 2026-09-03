import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/lib/store'
import { useTheme } from '@/lib/theme'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { InstallAppCard } from '@/components/InstallAppCard'
import { toast } from 'sonner'
import { Sun, Moon, Monitor, Download, Trash2, Loader2, Upload, X, Banknote, QrCode } from 'lucide-react'
import { initials } from '@/lib/utils'
import { imageFileToDataUrl, isImageFile } from '@/lib/image'
import type { PaymentMethod } from '@/lib/types'

export function SettingsPage() {
  const { settings, saveSettings, resetAllData, workers, entries, backend, user, isAdmin, updateOwnProfile, updateOwnPaymentMethods } = useStore()
  const { theme, setTheme } = useTheme()
  const [businessName, setBusinessName] = useState(settings?.business_name || '')
  const [currency, setCurrency] = useState(settings?.currency || 'USD')
  const [timezone, setTimezone] = useState(settings?.timezone || '')
  const [defaultRate, setDefaultRate] = useState(String(settings?.default_hourly_rate ?? 20))
  const [saving, setSaving] = useState(false)
  const [avatar, setAvatar] = useState(settings?.avatar_url || '')
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement | null>(null)

  // Admin account picture. Downscaled through the same helper as worker
  // pictures/QR codes so a huge photo can't bloat the settings row.
  function onPickAvatar(file?: File | null) {
    if (!file) return
    if (!isImageFile(file)) {
      toast.error('Please choose an image file.')
      return
    }
    imageFileToDataUrl(file)
      .then((url) => setAvatar(url))
      .catch(() => toast.error('That image could not be read. Please try another file.'))
  }

  // Worker self-service profile picture. A worker only ever sees their own
  // worker row (both backends scope listWorkers to the signed-in user), so this
  // is the current worker record whose avatar the admin will see.
  const myWorker = useMemo(
    () => workers.find((w) => w.id === user?.workerId) ?? null,
    [workers, user?.workerId]
  )
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Seed the avatar editor whenever the loaded worker row changes.
  useEffect(() => {
    setProfileAvatar(myWorker?.avatar_url ?? null)
  }, [myWorker?.id, myWorker?.avatar_url])

  // Worker self-service payment methods: which ways they can be paid (cash
  // and/or QR code), plus the QR code image required when QR is enabled.
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [savingPayment, setSavingPayment] = useState(false)
  const qrInputRef = useRef<HTMLInputElement | null>(null)
  // Seed the editor only when the *saved* payment data actually changes. The
  // store polls every few seconds and refreshes on window focus (e.g. when the
  // file picker closes), and each refresh rebuilds `workers` with new array
  // references. Depending on the `payment_methods` array reference itself made
  // those no-op refreshes wipe unsaved toggles and a just-picked QR image — so
  // compare a stable serialized key of the saved methods instead.
  const savedMethodsKey = (myWorker?.payment_methods ?? []).join(',')
  useEffect(() => {
    setMethods(myWorker?.payment_methods ?? [])
    setQrCode(savedMethodsKey.includes('qr') ? (myWorker?.qr_code_url ?? null) : null)
  }, [myWorker?.id, savedMethodsKey, myWorker?.qr_code_url])

  function toggleMethod(method: PaymentMethod, enabled: boolean) {
    setMethods((prev) => {
      const has = prev.includes(method)
      if (enabled && !has) return [...prev, method]
      if (!enabled && has) return prev.filter((m) => m !== method)
      return prev
    })
  }

  function onPickQr(file?: File | null) {
    if (!file) return
    if (!isImageFile(file)) {
      toast.error('Please choose an image file.')
      return
    }
    imageFileToDataUrl(file)
      .then((url) => setQrCode(url))
      .catch(() => toast.error('That image could not be read. Please try another file.'))
  }

  async function handleSavePayment() {
    if (savingPayment) return
    if (methods.length === 0) {
      toast.error('Choose at least one payment method.')
      return
    }
    if (methods.includes('qr') && !qrCode) {
      toast.error('Upload your QR code image to accept QR Code payments.')
      return
    }
    setSavingPayment(true)
    // Turn QR off (and clear its image server-side) unless it is enabled.
    const res = await updateOwnPaymentMethods(methods, methods.includes('qr') ? qrCode : null)
    setSavingPayment(false)
    if (!res) toast.error('Failed to save payment methods.')
    else toast.success('Payment methods updated.')
  }

  // Seed the General form only when the saved settings *content* changes.
  // Background refreshes rebuild the settings object (new reference, identical
  // content); reseeding on the reference wiped unsaved admin edits — including
  // a just-picked profile picture — whenever a refresh landed mid-edit.
  const savedSettingsKey = settings
    ? [settings.business_name, settings.currency, settings.timezone, settings.default_hourly_rate, settings.avatar_url ?? ''].join('|')
    : ''
  useEffect(() => {
    if (settings) {
      setBusinessName(settings.business_name)
      setCurrency(settings.currency)
      setTimezone(settings.timezone)
      setDefaultRate(String(settings.default_hourly_rate ?? 20))
      setAvatar(settings.avatar_url || '')
    }
  }, [savedSettingsKey])

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

  function onPickPicture(file?: File | null) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Please choose an image file.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => setProfileAvatar(String(reader.result))
    reader.readAsDataURL(file)
  }

  async function handleSaveProfile() {
    if (savingProfile) return
    setSavingProfile(true)
    const res = await updateOwnProfile(profileAvatar || null)
    setSavingProfile(false)
    if (!res) toast.error('Failed to save your profile picture.')
    else toast.success('Profile picture updated.')
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

  const workerTabVisible = !isAdmin && myWorker

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Manage your account and preferences." />

      <Tabs defaultValue={workerTabVisible ? 'profile' : isAdmin ? 'general' : 'appearance'}>
        <TabsList>
          {workerTabVisible && <TabsTrigger value="profile">Profile</TabsTrigger>}
          {workerTabVisible && <TabsTrigger value="payment">Payment methods</TabsTrigger>}
          {isAdmin && <TabsTrigger value="general">General</TabsTrigger>}
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="apps">Get the app</TabsTrigger>
          {isAdmin && <TabsTrigger value="data">Data</TabsTrigger>}
        </TabsList>

        <TabsContent value="apps" className="mt-4">
          <InstallAppCard />
        </TabsContent>

        {workerTabVisible && (
          <TabsContent value="profile" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Profile</CardTitle>
                <CardDescription>Add a profile picture so your manager and the rest of the team can recognize you.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Account info (read-only; set by your manager) */}
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your account</p>
                  <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-sm">
                    <div><span className="text-muted-foreground">Name:</span> <span className="font-medium">{myWorker.name}</span></div>
                    {myWorker.position && <div><span className="text-muted-foreground">Position:</span> <span className="font-medium">{myWorker.position}</span></div>}
                    {myWorker.email && <div><span className="text-muted-foreground">Email:</span> <span className="font-medium">{myWorker.email}</span></div>}
                  </div>
                </div>

                {/* Profile picture upload */}
                <div className="space-y-2">
                  <Label>Profile picture</Label>
                  <div className="flex items-center gap-4">
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-xl font-semibold text-primary">
                      {profileAvatar ? (
                        <img src={profileAvatar} alt="Profile preview" className="h-full w-full object-cover" />
                      ) : (
                        initials(myWorker.name)
                      )}
                    </div>
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                          <Upload className="mr-1 h-4 w-4" /> {profileAvatar ? 'Change picture' : 'Upload picture'}
                        </Button>
                        {profileAvatar && (
                          <Button type="button" variant="ghost" size="sm" onClick={() => { setProfileAvatar(null); if (fileInputRef.current) fileInputRef.current.value = '' }}>
                            <X className="mr-1 h-4 w-4" /> Remove
                          </Button>
                        )}
                      </div>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => { onPickPicture(e.target.files?.[0]); e.target.value = '' }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {profileAvatar
                          ? 'Save to apply your new picture. Your manager will see it next to your name.'
                          : 'Upload a JPG, PNG or GIF so you have a face next to your name.'}
                      </p>
                    </div>
                  </div>
                </div>

                <Button type="button" disabled={savingProfile} onClick={handleSaveProfile}>
                  {savingProfile && <Loader2 className="mr-1 animate-spin" />} Save picture
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {workerTabVisible && (
          <TabsContent value="payment" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Payment methods</CardTitle>
                <CardDescription>
                  Choose how you can be paid. Your manager sees the methods you accept on the Payments page — including your QR code when you enable QR Code payments.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Cash */}
                <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Banknote className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Cash</p>
                      <p className="text-xs text-muted-foreground">Paid in cash when your manager settles your time.</p>
                    </div>
                  </div>
                  <Switch
                    checked={methods.includes('cash')}
                    onCheckedChange={(v) => toggleMethod('cash', v)}
                    aria-label="Accept cash payments"
                  />
                </div>

                {/* QR Code */}
                <div className="rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <QrCode className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">QR Code</p>
                        <p className="text-xs text-muted-foreground">
                          Paid by scanning your QR code (GCash, Maya, bank app, etc.). Upload the QR image so your manager can scan it.
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={methods.includes('qr')}
                      onCheckedChange={(v) => toggleMethod('qr', v)}
                      aria-label="Accept QR code payments"
                    />
                  </div>

                  {methods.includes('qr') && (
                    <div className="mt-4 space-y-3 border-t pt-4">
                      <Label>Your QR code image</Label>
                      <div className="flex items-center gap-4">
                        <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white">
                          {qrCode ? (
                            <img src={qrCode} alt="Your payment QR code" className="h-full w-full object-contain" />
                          ) : (
                            <QrCode className="h-8 w-8 text-muted-foreground/50" />
                          )}
                        </div>
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => qrInputRef.current?.click()}>
                              <Upload className="mr-1 h-4 w-4" /> {qrCode ? 'Change image' : 'Upload QR code'}
                            </Button>
                            {qrCode && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => { setQrCode(null); if (qrInputRef.current) qrInputRef.current.value = '' }}
                              >
                                <X className="mr-1 h-4 w-4" /> Remove
                              </Button>
                            )}
                          </div>
                          <input
                            ref={qrInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => { onPickQr(e.target.files?.[0]); e.target.value = '' }}
                          />
                          <p className="text-xs text-muted-foreground">
                            {qrCode
                              ? 'Save to apply. Your manager can view and scan this QR code on the Payments page.'
                              : 'A screenshot or photo of your payment QR code (JPG or PNG).'}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {methods.length === 0 && (
                  <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    Enable at least one payment method so your manager knows how to pay you.
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <Button type="button" disabled={savingPayment} onClick={handleSavePayment}>
                    {savingPayment && <Loader2 className="mr-1 animate-spin" />} Save payment methods
                  </Button>
                  {methods.length > 0 && (
                    <div className="flex gap-1.5">
                      {methods.map((m) => (
                        <Badge key={m} variant="secondary" className="capitalize">
                          {m === 'qr' ? 'QR Code' : 'Cash'}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {isAdmin && (
        <TabsContent value="general" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>General</CardTitle>
              <CardDescription>Business details and default preferences.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSave} className="space-y-4">
                <div className="space-y-2">
                  <Label>Profile picture</Label>
                  <div className="flex items-center gap-4">
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-xl font-semibold text-primary">
                      {avatar ? (
                        <img src={avatar} alt="Profile preview" className="h-full w-full object-cover" />
                      ) : (
                        initials(user?.email || businessName || 'Admin')
                      )}
                    </div>
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => avatarInputRef.current?.click()}>
                          <Upload className="mr-1 h-4 w-4" /> {avatar ? 'Change picture' : 'Upload picture'}
                        </Button>
                        {avatar && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => { setAvatar(''); if (avatarInputRef.current) avatarInputRef.current.value = '' }}
                          >
                            <X className="mr-1 h-4 w-4" /> Remove
                          </Button>
                        )}
                      </div>
                      <input
                        ref={avatarInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => { onPickAvatar(e.target.files?.[0]); e.target.value = '' }}
                      />
                      <p className="text-xs text-muted-foreground">
                        {avatar
                          ? 'Save settings to apply your new picture. It appears next to your name in the header.'
                          : 'Upload a JPG, PNG or GIF to personalize your account.'}
                      </p>
                    </div>
                  </div>
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
        )}

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

        {isAdmin && (
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
        )}
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
