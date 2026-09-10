import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Last line of defense for the whole app. Without this, a single thrown
 * error (a bad row from the backend, a missing migration, a native-shell
 * quirk) unmounts the entire React tree into a blank white screen — in a
 * PWA or native app that means the user has to kill and reopen. With it,
 * the user sees what happened and a one-tap recovery path.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the detail for the logs — the on-screen message stays friendly.
    console.error('[work-tracker] uncaught UI error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-md space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <TriangleAlert className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              The app hit an unexpected error and reset its screen. Your data is safe — your clock, entries
              and payments live in the workspace, not in this view.
            </p>
          </div>
          <pre className="max-h-32 overflow-auto rounded-md bg-muted p-3 text-left text-xs text-muted-foreground">
            {this.state.error.message}
          </pre>
          <Button className="w-full" onClick={() => window.location.reload()}>
            <RotateCw className="mr-2 h-4 w-4" /> Reload the app
          </Button>
        </div>
      </div>
    )
  }
}
