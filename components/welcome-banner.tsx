"use client"

import { X } from "lucide-react"
import { welcomeCopy } from "@/lib/copy"

type WelcomeBannerProps = {
  onDismiss: () => void
}

export function WelcomeBanner({ onDismiss }: WelcomeBannerProps) {
  return (
    /* Fullscreen overlay: fixed + inset-0 covers the entire viewport.
       bg-black/40 = semi-transparent backdrop that dims the map underneath.
       Grid + place-items-center is the simplest way to dead-centre a child. */
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40">
      <div className="group relative w-full max-w-md overflow-hidden rounded-xl bg-card shadow-xl border border-border">
        {/* Close button — hidden until the dialog is hovered */}
        <button
          onClick={onDismiss}
          className="absolute top-3 right-3 z-10 rounded-full bg-black/40 p-1 text-white hover:bg-black/60 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
          aria-label="Dismiss dialog"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Hero image */}
        <img
          src={welcomeCopy.heroImage}
          alt={welcomeCopy.heroAlt}
          className="w-full aspect-video object-cover"
        />

        {/* Text content + CTA */}
        <div className="p-6">
          <h2 className="text-lg font-semibold text-foreground">
            {welcomeCopy.heading}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {welcomeCopy.body}
          </p>
          <button
            onClick={onDismiss}
            className="mt-5 w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
          >
            {welcomeCopy.cta}
          </button>
        </div>
      </div>
    </div>
  )
}
