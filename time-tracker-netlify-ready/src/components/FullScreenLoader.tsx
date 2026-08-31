export function FullScreenLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <img
          src="/brand/pipelinesync-icon.png"
          alt="PipelineSync"
          className="h-14 w-14 animate-pulse-slow"
          draggable={false}
        />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    </div>
  )
}
