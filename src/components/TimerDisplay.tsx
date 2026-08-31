import { formatDurationFromMs } from '@/lib/utils'

export function TimerDisplay({ ms, running }: { ms: number; running?: boolean }) {
  return (
    <div className="relative">
      {running && (
        <span className="absolute -left-5 top-1/2 h-3 w-3 -translate-y-1/2 animate-pulse rounded-full bg-[#F77A0A]" aria-hidden />
      )}
      <div className="font-mono text-5xl font-bold tracking-tight tabular-nums sm:text-6xl">
        {formatDurationFromMs(ms)}
      </div>
    </div>
  )
}
