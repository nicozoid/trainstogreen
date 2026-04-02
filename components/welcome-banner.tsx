"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { welcomeCopy } from "@/lib/copy"

type WelcomeBannerProps = {
  open: boolean
  onDismiss: () => void
  /** Screen-pixel position of the London icon — omit for a generic animation */
  originX?: number
  originY?: number
}

const ANIM_DURATION = 400 // ms

export function WelcomeBanner({ open, onDismiss, originX, originY }: WelcomeBannerProps) {
  // ── Manual close animation ──
  // Same pattern as StationModal: keep the component mounted while playing the
  // exit animation ourselves, then actually dismiss after the timer fires.
  const [isClosing, setIsClosing] = useState(false)
  const closingTimer = useRef<ReturnType<typeof setTimeout>>(null)
  // Track whether banner has ever been open — prevents exit animation on first render
  const hasOpened = useRef(false)

  useEffect(() => {
    if (open) {
      setIsClosing(false)
      hasOpened.current = true
    }
    return () => { if (closingTimer.current) clearTimeout(closingTimer.current) }
  }, [open])

  const handleAnimatedClose = useCallback(() => {
    if (isClosing) return
    setIsClosing(true)
    closingTimer.current = setTimeout(() => {
      setIsClosing(false)
      onDismiss()
    }, ANIM_DURATION * 0.65)
  }, [isClosing, onDismiss])

  // Don't render anything until the banner has been opened at least once,
  // and hide after close animation finishes
  const visible = open || isClosing
  if (!visible && !hasOpened.current) return null
  if (!visible) return null

  // ── Animation styles ──
  // Desktop: grow from / shrink to the London icon (if origin provided).
  // Mobile: slide up from / down to the bottom of the screen.
  // First load (no origin): fade + scale from center.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 640
  const hasOrigin = originX != null && originY != null

  let cardStyle: React.CSSProperties
  let backdropStyle: React.CSSProperties

  if (isClosing) {
    // Exit animation — set directly as inline animation to override any other styles
    backdropStyle = {
      animation: `exit ${ANIM_DURATION * 0.65}ms ease forwards`,
      "--tw-exit-opacity": "0",
    } as React.CSSProperties

    if (isMobile) {
      cardStyle = {
        animation: `exit ${ANIM_DURATION * 0.65}ms cubic-bezier(0.4, 0, 1, 1) forwards`,
        "--tw-exit-translate-y": "100vh",
      } as React.CSSProperties
    } else if (hasOrigin) {
      // Shrink to the London icon position
      const exitX = originX - window.innerWidth / 2
      const exitY = originY - window.innerHeight / 2
      cardStyle = {
        animation: `exit ${ANIM_DURATION * 0.65}ms cubic-bezier(0.4, 0, 1, 1) forwards`,
        "--tw-exit-translate-x": `${exitX}px`,
        "--tw-exit-translate-y": `${exitY}px`,
        "--tw-exit-scale": "0.02",
        "--tw-exit-opacity": "0",
      } as React.CSSProperties
    } else {
      // No origin — just fade + scale out
      cardStyle = {
        animation: `exit ${ANIM_DURATION * 0.65}ms cubic-bezier(0.4, 0, 1, 1) forwards`,
        "--tw-exit-scale": "0.95",
        "--tw-exit-opacity": "0",
      } as React.CSSProperties
    }
  } else {
    // Enter animation — uses tw-animate-css's data-open:animate-in via classes
    backdropStyle = {}

    if (isMobile) {
      cardStyle = {
        "--tw-enter-translate-y": "100vh",
        "--tw-duration": `${ANIM_DURATION}ms`,
        "--tw-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
      } as React.CSSProperties
    } else if (hasOrigin) {
      // Grow from the London icon position
      const enterX = originX - window.innerWidth / 2
      const enterY = originY - window.innerHeight / 2
      cardStyle = {
        "--tw-enter-translate-x": `${enterX}px`,
        "--tw-enter-translate-y": `${enterY}px`,
        "--tw-enter-scale": "0.02",
        "--tw-enter-opacity": "0",
        "--tw-duration": `${ANIM_DURATION}ms`,
        "--tw-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
      } as React.CSSProperties
    } else {
      // First load (no icon click) — gentle fade + scale up from center
      cardStyle = {
        "--tw-enter-scale": "0.95",
        "--tw-enter-opacity": "0",
        "--tw-duration": `${ANIM_DURATION}ms`,
        "--tw-ease": "cubic-bezier(0.16, 1, 0.3, 1)",
      } as React.CSSProperties
    }
  }

  return (
    /* Fullscreen overlay: fixed + inset-0 covers the entire viewport.
       bg-black/40 = semi-transparent backdrop that dims the map underneath.
       Grid + place-items-center is the simplest way to dead-centre a child. */
    /* onClick on the backdrop calls handleAnimatedClose; the inner card stops
       propagation so clicking inside it doesn't bubble up and trigger dismissal. */
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 animate-in fade-in-0 duration-200"
      style={backdropStyle}
      onClick={handleAnimatedClose}
    >
      <div
        className="group relative w-full max-w-md overflow-hidden rounded-xl bg-card shadow-xl animate-in max-sm:self-end max-sm:rounded-b-none"
        style={cardStyle}
        onClick={e => e.stopPropagation()}
      >
        {/* Close button — hidden until the dialog is hovered */}
        <button
          onClick={handleAnimatedClose}
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
          <p className="mt-2 text-sm leading-relaxed text-foreground font-normal">
            {welcomeCopy.body}
          </p>
          <p className="mt-3 text-sm text-foreground font-normal">
            Send any comments or questions to{" "}
            <a
              href="mailto:nicolas@niczap.design"

            >
              nicolas@niczap.design
            </a>.
          </p>
          <button
            onClick={handleAnimatedClose}
            className="mt-5 w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
          >
            {welcomeCopy.cta}
          </button>
        </div>
      </div>
    </div>
  )
}
