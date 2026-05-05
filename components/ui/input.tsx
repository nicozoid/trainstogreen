import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Input renders a text input with an optional built-in "clear" (X) button
 * that appears whenever the input is controlled AND has a non-empty string
 * value. Clicking the button dispatches a synthetic onChange event with an
 * empty string so consumers' existing handlers clear their state without any
 * API change.
 *
 * Uncontrolled inputs (no `value` prop, or `value` that isn't a non-empty
 * string) render exactly as before — no wrapper chrome, no clear button.
 *
 * When the clear button is visible, the input automatically reserves pr-8
 * so typed text never slides underneath the button.
 *
 * `hideClear` opts an individual call site out of the clear button without
 * affecting the rest of the design system — useful for narrow numeric or
 * structural fields where the X would steal valuable horizontal space.
 */
function Input({
  className,
  type,
  value,
  onChange,
  hideClear,
  ...props
}: React.ComponentProps<"input"> & { hideClear?: boolean }) {
  // Only render the clear button for controlled inputs with a non-empty
  // string value. Number inputs or files aren't cleared through this path.
  // `hideClear` lets callers force-disable the button regardless.
  const hasClearableValue = !hideClear && typeof value === "string" && value.length > 0

  const handleClear = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    if (!onChange) return
    // Synthesise a minimal ChangeEvent so consumers that read
    // e.target.value (the common pattern) receive the empty string without
    // needing to know this is a synthetic event. Cast through unknown
    // because we don't fabricate every property of a real SyntheticEvent —
    // in practice only target.value is consumed.
    const synthetic = {
      target: { value: "" },
      currentTarget: { value: "" },
    } as unknown as React.ChangeEvent<HTMLInputElement>
    onChange(synthetic)
  }

  // Always render the same wrapper+input structure so toggling the clear
  // button's visibility doesn't unmount/remount the <input>. Earlier this
  // component conditionally skipped the wrapper when there was nothing to
  // clear — which LOOKED like a nice fast-path, but caused the input to
  // lose focus the moment a user typed their first character (the DOM
  // structure changed, React remounted the input element, and the
  // keystroke that triggered the state change ended up escaping to the
  // surrounding Radix DropdownMenu's typeahead handler instead of staying
  // in the input). Keeping the wrapper constant keeps focus intact.
  return (
    // relative span lets the clear button be absolutely positioned inside
    // the input's visible area. span (not div) so the wrapper stays inline-
    // level by default — avoids stretching grids/flex rows it's embedded
    // in. The wrapper takes block width via w-full so the input keeps
    // filling its container the way a bare <input> would.
    <span className="relative inline-block w-full">
      <input
        type={type}
        value={value}
        onChange={onChange}
        data-slot="input"
        className={cn(
          // rounded-lg (design-system default for search inputs): matches the
          // admin "Search stations" look — a gentle 8px corner radius. The
          // old default was rounded-4xl (a pill shape) which was too loud
          // for search bars embedded in cards/dropdowns. Keeping this as
          // the base so any <Input> looks consistent; callers who want a
          // pill can still pass rounded-full or similar via className.
          // Placeholder tone: muted-foreground at 60% opacity so empty
          // inputs read as "yet-to-fill" rather than looking like real
          // content. Muted-foreground alone is too close to real text
          // colour for placeholders that double as inline labels.
          "h-9 w-full min-w-0 rounded-lg border border-input bg-input/30 px-3 py-1 text-base transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
          // Reserve trailing space for the clear button so typed text doesn't
          // run underneath it. Only applied when the button is visible so
          // empty inputs keep their natural padding.
          hasClearableValue && "pr-8",
          className,
        )}
        {...props}
      />
      {hasClearableValue && (
        <button
          type="button"
          onClick={handleClear}
          // inset-y-0 + my-auto centres the button vertically. right-1.5
          // matches SearchBar's historical positioning. p-1 expands the tap
          // target beyond the 14px icon. cursor-pointer makes clickability
          // obvious; hover swap from muted to normal foreground gives a
          // subtle affordance.
          className="absolute inset-y-0 right-1.5 my-auto flex items-center p-1 cursor-pointer text-muted-foreground hover:text-foreground"
          aria-label="Clear"
        >
          <X size={14} />
        </button>
      )}
    </span>
  )
}

export { Input }
