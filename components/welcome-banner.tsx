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
    /* onClick on the backdrop calls onDismiss; the inner card stops propagation
       so clicking inside it doesn't bubble up and trigger dismissal. */
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onClick={onDismiss}>
      <div className="group relative w-full max-w-md overflow-hidden rounded-xl bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        {/* Close button — hidden until the dialog is hovered */}
        <button
          onClick={onDismiss}
          className="absolute top-3 right-3 z-10 rounded-full dark bg-accent/50 p-1 text-accent-foreground hover:bg-accent/80 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
          aria-label="Dismiss dialog"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Hero image + logo overlay */}
        <div className="relative">
          <img
            src={welcomeCopy.heroImage}
            alt={welcomeCopy.heroAlt}
            className="w-full aspect-video object-cover"
          />
          {/* Logo floating over the image, top-left, two-thirds of the card width.
              The mask technique: bg colour shows through the SVG's shape only.
              aspect-[591/50] matches the logo SVG's own viewBox dimensions. */}
          <div
            className="absolute top-3 left-3 w-1/3 bg-[#161D37]"
            style={{
              aspectRatio: "591 / 50",
              maskImage: "url(/trainstogreen-logo.svg)",
              maskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskImage: "url(/trainstogreen-logo.svg)",
              WebkitMaskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
            }}
            role="img"
            aria-label="Trains to Green"
          />
        </div>

        {/* Text content + CTA */}
        <div className="p-6">
          <h2 className="text-lg font-semibold ">
            {welcomeCopy.heading}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground font-light">
            {welcomeCopy.body}
          </p>
          <p className="mt-3 text-sm text-foreground font-light">
            Send any comments or questions to{" "}
            <a
              href="mailto:nicolas@niczap.design"
              
            >
              nicolas@niczap.design
            </a>.
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
