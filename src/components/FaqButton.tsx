import { useState } from 'react'
import { useStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ChevronDown, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FAQ_FOOTER,
  FAQ_INTRO,
  FAQ_SECTIONS,
  FAQ_TITLE,
  type FaqAudience,
} from '@/lib/faq'

/**
 * The **FAQs** button: a very small circle with a question mark in it.
 *
 * It is the same affordance in both places it is used — pinned to the
 * **upper-left of the section it explains** through `PageHeader`'s `leading`
 * slot: the Clock In / Out screen for a worker, the Dashboard for the admin.
 * Small on purpose: it is help you reach for once, not a call to action
 * competing with Clock In.
 *
 * The answers themselves are plain data (`@/lib/faq`), picked by audience. Pass
 * `audience` to pin it to the *screen* (the tracker is a worker screen by
 * definition); leave it off to follow the *signed-in account*, which is what
 * the Dashboard wants — a worker who has been granted `dashboard.view` gets the
 * worker answers there, not a list about managing workers.
 */
export function FaqButton({
  audience,
  className,
}: {
  audience?: FaqAudience
  className?: string
}) {
  const { isAdmin } = useStore()
  const who: FaqAudience = audience ?? (isAdmin ? 'admin' : 'worker')
  const sections = FAQ_SECTIONS[who]

  // The first question starts open so the dialog is never a wall of closed
  // rows, and re-opening it resets to that state rather than remembering a
  // random answer from last time.
  const firstId = sections[0]?.items[0]?.id ?? null
  const [openId, setOpenId] = useState<string | null>(firstId)

  return (
    <Dialog onOpenChange={(open) => open && setOpenId(firstId)}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="iconSm"
          aria-label="FAQs"
          title="FAQs"
          className={cn(
            // h-6 w-6: a 24px circle with a 14px glyph in it — deliberately the
            // smallest thing on the page. (The size utilities win over the
            // variant's own h-8/w-8 and [&_svg]:size-4 through tailwind-merge.)
            'h-6 w-6 shrink-0 rounded-full border border-border/70 p-0 text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3.5',
            className
          )}
        >
          <HelpCircle />
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{FAQ_TITLE[who]}</DialogTitle>
          <DialogDescription>{FAQ_INTRO[who]}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {sections.map((section) => (
            <section key={section.title} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {section.title}
              </h3>
              <div className="divide-y divide-border overflow-hidden rounded-lg border">
                {section.items.map((item) => {
                  const expanded = openId === item.id
                  return (
                    <div key={item.id}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setOpenId(expanded ? null : item.id)}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium hover:bg-muted/50"
                      >
                        <span className="flex-1">{item.question}</span>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                            expanded && 'rotate-180'
                          )}
                        />
                      </button>
                      {expanded && (
                        <p className="px-3 py-2.5 pt-0 text-sm leading-relaxed text-muted-foreground">
                          {item.answer}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        <p className="border-t pt-3 text-xs text-muted-foreground">{FAQ_FOOTER[who]}</p>
      </DialogContent>
    </Dialog>
  )
}
