import { useState } from 'react'
import { CheckCircle2, Download, MonitorSmartphone, Share, Sparkles } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useInstallPrompt } from '@/lib/useInstallPrompt'
import { platformKind, PLATFORM_LABEL, isNativeShell, isStandalonePwa } from '@/lib/platform'
import { toast } from 'sonner'

const STEP_BY_PLATFORM: Record<string, { icon: typeof Share; title: string; steps: string[] }> = {
  ios: {
    icon: Share,
    title: 'Install on iPhone / iPad',
    steps: [
      'Open this site in Safari.',
      'Tap the Share button (the square with an up arrow).',
      'Choose “Add to Home Screen”, then “Add”.',
      'PipelineSync launches full-screen from your home screen, with its own icon — and keeps working offline.',
    ],
  },
  android: {
    icon: Download,
    title: 'Install on Android',
    steps: [
      'Open this site in Chrome.',
      'Tap the ⋮ menu, then “Install app” (or “Add to Home screen”).',
      'Confirm the install — PipelineSync appears in your app drawer like any other app.',
    ],
  },
  desktop: {
    icon: MonitorSmartphone,
    title: 'Install on Windows / macOS / Linux',
    steps: [
      'Open this site in Chrome or Edge.',
      'Click the install icon at the right end of the address bar (or Menu → “Install PipelineSync…”).',
      'The app opens in its own window with a task-bar / Dock icon and runs offline.',
    ],
  },
}

export function InstallAppCard() {
  const { canPrompt, installed, promptInstall } = useInstallPrompt()
  const [busy, setBusy] = useState(false)
  const kind = platformKind()
  const native = isNativeShell()
  const steps = STEP_BY_PLATFORM[kind === 'ios' ? 'ios' : kind === 'android' ? 'android' : 'desktop']
  const StepsIcon = steps.icon

  async function onInstall() {
    setBusy(true)
    const outcome = await promptInstall()
    setBusy(false)
    if (outcome === 'accepted') toast.success('PipelineSync is installed. Launch it from your home screen or app list.')
    else if (outcome === 'dismissed') toast.message('Install dismissed — you can install any time from Settings.')
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Get the app</CardTitle>
            <CardDescription>
              Put PipelineSync on this device as a real app — home-screen icon, full-screen window and offline
              support. Same account, same data, everywhere.
            </CardDescription>
          </div>
          <Badge variant="secondary" className="shrink-0 gap-1">
            <MonitorSmartphone className="h-3.5 w-3.5" />
            {PLATFORM_LABEL[kind]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {native ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            You are using the native {PLATFORM_LABEL[kind]} build of PipelineSync.
          </p>
        ) : installed || isStandalonePwa() ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            PipelineSync is installed on this device and running as an app.
          </p>
        ) : canPrompt ? (
          <Button onClick={onInstall} disabled={busy} className="gap-2">
            <Download className="h-4 w-4" />
            {busy ? 'Installing…' : 'Install PipelineSync'}
          </Button>
        ) : (
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <StepsIcon className="h-4 w-4 text-primary" />
              {steps.title}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              {steps.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        )}

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            Need a store build? Native iPhone / Android apps and Windows / macOS installers are produced from this
            exact codebase — see <code className="font-mono">docs/APPS.md</code> in the repository for the one-command
            builds and the release workflows.
          </span>
        </p>
      </CardContent>
    </Card>
  )
}
