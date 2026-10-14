import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { randomTreatMessage, useTreats } from './treats'

function BagIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" focusable="false">
      <path d="M8 7c0-2.2 1.8-4 4-4s4 1.8 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M5 8h14l-1.3 11.2A2 2 0 0 1 15.7 21H8.3a2 2 0 0 1-2-1.8z" fill="currentColor" opacity=".9" />
      <path d="M9.3 12.5l1.4 1.2M14.7 12.5l-1.4 1.2M9.5 16c1.5 1.1 3.5 1.1 5 0" stroke="#1a0a00" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  )
}

/**
 * Header candy bag: fills up as you finish tasks and clock out today. Click it
 * for a treat. The count lives in this browser only (see ./treats.ts).
 */
export function CandyBag() {
  const treats = useTreats()
  const [popping, setPopping] = useState(false)
  const [message, setMessage] = useState('')
  const firstBump = useRef(treats.bump)

  useEffect(() => {
    if (treats.bump === firstBump.current) return
    setPopping(true)
    const t = window.setTimeout(() => setPopping(false), 650)
    return () => window.clearTimeout(t)
  }, [treats.bump])

  const label = `Treat bag: ${treats.candy} ${treats.candy === 1 ? 'candy' : 'candies'} today`

  return (
    <DropdownMenu onOpenChange={(open) => open && setMessage(randomTreatMessage())}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} title={label} className="relative text-brand-2">
          <span className={popping ? 'halloween-bag-pop' : undefined}>
            <BagIcon />
          </span>
          {treats.candy > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 font-mono text-[10px] font-bold text-[#1a0a00]">
              {treats.candy}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-3">
        <DropdownMenuLabel className="px-0">Trick or treat</DropdownMenuLabel>
        {treats.candy > 0 ? (
          <p className="text-sm">{message}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Your bag is empty. Finish a task or clock out to collect treats.</p>
        )}
        <DropdownMenuSeparator className="my-3" />
        <ul className="space-y-1 font-mono text-xs text-muted-foreground">
          <li>Finish a task: +1</li>
          <li>Clock out: +1</li>
          <li>8 hours in a day: +3 {treats.fullBag ? '(collected)' : ''}</li>
        </ul>
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          Today: <span className="tabular-nums text-foreground">{treats.candy}</span> · resets at midnight
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
