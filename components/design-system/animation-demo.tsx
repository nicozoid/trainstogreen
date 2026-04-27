"use client"

/**
 * Plays an animation token live, with a Replay button.
 *
 * Why "Replay": some animations (the orbit, the shimmer) loop
 * forever, but others might one-shot. To make the card useful for
 * either case, the demo div is keyed by a counter — bumping the
 * counter remounts the div, restarting the animation from frame 0.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { TokenCard } from "./token-card"
import { useCssVar } from "./use-css-var"
import type { AnimationEntry } from "@/lib/design-system/tokens"

export function AnimationDemo({ token }: { token: AnimationEntry }) {
  // Counter bumped by Replay. Used as the key so React remounts the
  // animated element, restarting the animation. (Just toggling a
  // class wouldn't restart — CSS keeps the existing animation
  // running.)
  const [iteration, setIteration] = useState(0)

  // For tokens that have a CSS-var shorthand, also surface the
  // resolved value. cssVar may be missing for keyframes used inline.
  const { value, ref } = useCssVar(token.cssVar ?? "")

  const visualisation = (
    <div ref={ref} className="flex w-full flex-col items-center gap-3">
      {/* The animated element. key={iteration} forces a remount on
          replay. We render two different demos depending on the
          token name — shimmer wants a horizontal box, orbit wants a
          tracing dot. */}
      {token.name === "shimmer" ? (
        // Skeleton-like row with a sweeping highlight. The bar has
        // a translucent gradient that gets translated by the keyframe
        // — same effect as the real loading skeletons in the app.
        <div
          key={iteration}
          className="relative h-6 w-full overflow-hidden rounded bg-muted"
        >
          <div
            className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-foreground/20 to-transparent"
            style={{ animation: token.inlineAnimation }}
          />
        </div>
      ) : (
        // orbit: a small dot tracing the keyframe. The container is
        // the orbit centre; the dot is positioned at one orbit-radius
        // from centre and the keyframe translates it.
        <div className="relative size-12">
          <div
            key={iteration}
            className="absolute top-1/2 left-1/2 size-1.5 -translate-1/2 rounded-full bg-primary"
            style={{ animation: token.inlineAnimation }}
          />
        </div>
      )}

      {/* Replay button. variant="outline" to keep it visually quiet
          since the demo above is the focus. */}
      <Button
        variant="outline"
        size="xs"
        onClick={() => setIteration((n) => n + 1)}
      >
        Replay
      </Button>
    </div>
  )

  return (
    <TokenCard
      visualisation={visualisation}
      name={token.cssVar ?? token.name}
      value={value || token.inlineAnimation}
      description={token.description}
    />
  )
}
