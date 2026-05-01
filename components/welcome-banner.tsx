"use client"

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { X } from "lucide-react"
import { welcomeCopy } from "@/lib/copy"
import { LogoSpinner } from "@/components/logo-spinner"

type WelcomeBannerProps = {
  open: boolean
  onDismiss: () => void
  /** Screen-pixel position of the London icon — omit for a generic animation */
  originX?: number
  originY?: number
  /**
   * When true, the CTA button is replaced with a loading spinner and the
   * banner can't be dismissed (backdrop clicks + close button are ignored).
   * Flips to the normal button once the map data has finished computing.
   */
  isLoading?: boolean
  /**
   * True when the user opened the banner deliberately via the ? help
   * button (rather than the default cold-start appearance). Surfaces a
   * data-attribution footer at the bottom of the card — useful info,
   * but not something we want to greet first-time visitors with.
   */
  summoned?: boolean
}

/**
 * Imperative handle the parent can grab via ref. `close()` triggers the
 * same exit-animation path as a backdrop click or the X button — lets the
 * parent dismiss via an external control (e.g. toggling the ? help icon)
 * without bypassing the animation.
 */
export type WelcomeBannerHandle = {
  close: () => void
}

const ANIM_DURATION = 400 // ms

export const WelcomeBanner = forwardRef<WelcomeBannerHandle, WelcomeBannerProps>(function WelcomeBanner(
  { open, onDismiss, originX, originY, isLoading = false, summoned = false },
  ref,
) {
  // ── Manual close animation ──
  // Same pattern as StationModal: keep the component mounted while playing the
  // exit animation ourselves, then actually dismiss after the timer fires.
  const [isClosing, setIsClosing] = useState(false)
  const closingTimer = useRef<ReturnType<typeof setTimeout>>(null)
  // Track whether banner has ever been open — prevents exit animation on first render
  const hasOpened = useRef(false)
  // Track whether the banner has EVER been closed. Starts false; set true
  // the first time the user dismisses the banner. We can't reuse
  // `hasOpened` for "is this the first time the banner is visible?"
  // because hasOpened flips to true inside useEffect after the first
  // render — so on the very next render `!hasOpened.current` is false,
  // which re-adds the `animate-in` class and causes tw-animate-css to
  // replay the entry animation (the "washed-out initial frame"). A
  // dedicated ref that only flips on close gives us a stable signal
  // for "suppress the entry animation" that persists across re-renders
  // during the initial open session.
  const hasEverClosed = useRef(false)

  useEffect(() => {
    if (open) {
      setIsClosing(false)
      hasOpened.current = true
    }
    return () => { if (closingTimer.current) clearTimeout(closingTimer.current) }
  }, [open])

  const handleAnimatedClose = useCallback(() => {
    // Block dismissal while the map is still loading — forces the
    // user to wait for data + routing before interacting with the map.
    if (isLoading) return
    if (isClosing) return
    // Mark that the banner has been closed at least once — any future
    // open will get the usual tw-animate-css entry animation.
    hasEverClosed.current = true
    setIsClosing(true)
    closingTimer.current = setTimeout(() => {
      setIsClosing(false)
      onDismiss()
    }, ANIM_DURATION * 0.65)
  }, [isClosing, onDismiss, isLoading])

  // Expose close() so the parent can trigger the animated exit flow
  // from external controls (e.g. toggling the ? help icon). Callers
  // should use this rather than setting `open=false` directly, otherwise
  // the banner unmounts without the exit animation.
  useImperativeHandle(ref, () => ({
    close: handleAnimatedClose,
  }), [handleAnimatedClose])

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
  // Initial app load: the banner is visible synchronously with the
  // map mounting, and we want the spinner to be visible *immediately*
  // at full opacity rather than fading in with the rest of the card.
  // `hasEverClosed` only flips true when the user dismisses the
  // banner — so until that happens, every render during the initial
  // open session skips the tw-animate-css entry animation. Using
  // `hasOpened` here would fail: that ref flips true in useEffect
  // after the first render, which means the SECOND render would add
  // `animate-in` back and replay the entry, causing the flash of
  // washed-out opacity on mount.
  const isFirstOpen = !hasEverClosed.current && open

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
  } else if (isFirstOpen) {
    // Cold-start on app load — skip all entry animations so the
    // spinner is instantly visible at full opacity. No fade-in, no
    // scale-in. The `animate-in` classes on the backdrop / card are
    // also conditionally stripped below so the spinner doesn't
    // flash through a partial-opacity state on mount.
    backdropStyle = {}
    cardStyle = {}
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
      className={`fixed inset-0 z-50 grid place-items-center bg-black/40 ${
        isFirstOpen ? "" : "animate-in fade-in-0 duration-200"
      }`}
      style={backdropStyle}
      onClick={handleAnimatedClose}
    >
      <div
        className={`group relative w-full max-w-md overflow-hidden rounded-xl bg-card shadow-xl max-sm:self-end max-sm:rounded-b-none ${
          isFirstOpen ? "" : "animate-in"
        }`}
        style={cardStyle}
        onClick={e => e.stopPropagation()}
      >
        {/* Close button — hidden until the dialog is hovered, AND fully
            hidden while loading (can't dismiss until data is ready). */}
        {!isLoading && (
          <button
            onClick={handleAnimatedClose}
            className="absolute top-3 right-3 z-10 rounded-full dark bg-accent/50 p-1 text-accent-foreground hover:bg-accent/80 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
            aria-label="Dismiss dialog"
          >
            <X className="h-4 w-4" />
          </button>
        )}

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
          {/* CTA slot: shows EITHER a thick primary-colour ring
              spinner (while the map data is still computing) OR the
              "Find stations" button once loading is done. The outer
              wrapper has a fixed min-height matching the button's
              rendered height so layout doesn't jump when the swap
              happens. The spinner itself is a pure CSS ring — a
              circular element with a 3px transparent border whose
              top edge is primary-coloured, rotated by `animate-spin`
              (Tailwind's 1s linear infinite rotation). */}
          {/* CTA slot — contains BOTH the standalone spinner and the
              "Find stations" button, stacked in the same position.
              While loading, the spinner is visible (primary green)
              and the button is fully transparent + non-interactive.
              When loading completes, the two cross-fade: spinner
              fades out, button fades in and becomes clickable. The
              relative wrapper gives both elements a shared positioning
              context; `min-h-[52px]` keeps the slot from collapsing
              during the fade. */}
          {/* Data-attribution footer — only when the user opened the
              banner via the ? button. Hidden on first cold-start so the
              welcome screen stays focused on the core message. The
              Historic Counties Trust licence asks for an acknowledgement
              when their boundary data is used (we use it to flag the
              station's historic county on the modal subtitle when it
              differs from the modern ceremonial county). Sits ABOVE the
              CTA so the button stays the visual end of the card. */}
          {summoned && (
            <p className="mt-5 text-xs text-muted-foreground">
              Historic county data from the{" "}
              <a
                href="https://www.county-borders.co.uk"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-muted-foreground/50 hover:decoration-muted-foreground"
              >
                Historic County Borders Project
              </a>
              .
            </p>
          )}
          {/* CTA slot is only rendered on cold-start (the initial app-
              load welcome). When the banner is re-summoned via the ?
              button the user already knows the app — the X / backdrop
              tap / second ? press are enough to dismiss, so the
              "Find stations" button would just be visual noise. */}
          {!summoned && (
          <div className="mt-5 relative min-h-[56px]">
            {/* Spinner layer — absolutely-positioned, primary-colour
                ("text-primary" sets `color`, which the SVG strokes
                inherit via `currentColor`). Fades out once loading
                completes; `pointer-events-none` lets clicks pass
                through to the button while it fades out. */}
            <div
              aria-hidden={!isLoading}
              // Fades out quickly (250ms) so the button-in can start
              // sooner. pointer-events-none lets clicks fall through
              // to the button while the spinner is mid-fade.
              className={`absolute inset-0 flex items-center justify-center text-primary transition-opacity duration-[250ms] ${
                isLoading ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
            >
              {/* Full TRAINS TO GREEN logo mark as a loading
                  indicator: equilateral triangle with a short
                  vertical stem (the "tree") + two almost-touching
                  wheels (the "GG" glyph) joined by an animated
                  coupling rod, all sitting on a horizontal baseline.
                  Proportions come from public/trainstogreen-logo.svg
                  (glyph portion ≈ 144×52 units — mirrored here).
                  Only the coupling rod animates: both its endpoints
                  orbit a shared 2.5px-radius invisible circle in
                  lockstep, so the rod translates rigidly rather
                  than tilting — reads like a locomotive side rod.
                  The rod uses a CSS keyframe (`orbit` in
                  globals.css) rather than SMIL <animateMotion> so
                  the browser can run it on the compositor thread;
                  that keeps the motion ticking even while the main
                  thread is briefly frozen by the heavy routing
                  pass. */}
              {/* Spinner component — reusable logo glyph with
                  animated coupling rod. Shared with the Flickr
                  photo-loading panel. See components/logo-spinner.tsx. */}
              <LogoSpinner className="h-8" label="Loading map data" />
            </div>

            {/* CTA button — always mounted so the slot has a stable
                height. `disabled` + `opacity-0` + `pointer-events-
                none` during loading so it can't be clicked while
                hidden; once loading completes it fades in over
                300ms, matching the spinner's fade-out. */}
            <button
              onClick={handleAnimatedClose}
              disabled={isLoading}
              aria-hidden={isLoading}
              // 500ms fade-in with a 200ms delay so the spinner is
              // mostly gone before the button starts appearing —
              // makes the swap feel intentional rather than abrupt.
              // No delay on fade-OUT (would appear only if the
              // banner somehow re-entered loading), only on the
              // fade-IN transition from opacity-0 to opacity-100.
              className={`w-full rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-opacity duration-500 cursor-pointer disabled:cursor-default ${
                isLoading ? "opacity-0 pointer-events-none" : "opacity-100 delay-200"
              }`}
            >
              {welcomeCopy.cta}
            </button>
          </div>
          )}
        </div>
      </div>
    </div>
  )
})
