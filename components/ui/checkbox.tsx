"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { HugeiconsIcon } from "@hugeicons/react"
import { Tick02Icon } from "@hugeicons/core-free-icons"

/* Keyframes + selector rules injected once via <style> tag.
   Tailwind v4 / Turbopack tree-shakes attribute selectors from .css files,
   so we inject them here to keep them co-located with the component. */
const checkmarkStyles = `
@keyframes checkmark-draw {
  from { stroke-dashoffset: 21; }
  to   { stroke-dashoffset: 0; }
}
@keyframes checkmark-erase {
  from { stroke-dashoffset: 0; }
  to   { stroke-dashoffset: 21; }
}
[data-slot="checkbox-indicator"] path {
  stroke-dasharray: 21;
}
[data-slot="checkbox-indicator"][data-state="checked"] path {
  animation: checkmark-draw 200ms ease-out forwards;
}
[data-slot="checkbox-indicator"][data-state="unchecked"] path {
  animation: checkmark-erase 150ms ease-in forwards;
}
`

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <>
      {/* Inject animation styles into <head> — React dedupes identical <style> tags */}
      <style>{checkmarkStyles}</style>
      <CheckboxPrimitive.Root
        data-slot="checkbox"
        className={cn(
          "peer relative flex size-4 shrink-0 items-center justify-center rounded-[6px] border border-input transition-shadow outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary hover:scale-105 hover:shadow-md",
          className
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator
          forceMount
          data-slot="checkbox-indicator"
          className="grid place-content-center text-current [&>svg]:size-2.5"
        >
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={3.5} strokeLinejoin="miter" strokeLinecap="square" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    </>
  )
}

export { Checkbox }
