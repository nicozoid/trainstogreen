/**
 * Component registry for the DS app.
 *
 * Each entry is a metadata record; the actual variant grids live as
 * separate React components under
 * components/design-system/component-variants/. This split keeps the
 * registry plain data while letting each component's demo be
 * hand-written (which is necessary because every component has a
 * different shape — there's no useful generic "render any variant"
 * function).
 *
 * Tiered per the Molecule / Cell / Tissue / Organ framework — the
 * tier semantics are documented on the components landing page.
 */

// One entry per component.
export type ComponentEntry = {
  id: string;          // stable identifier — also used as the React key + URL anchor
  name: string;        // display name (e.g. "Button")
  description: string; // what the component does in the app
  // Source path relative to the repo root. Used both for a "where it
  // lives" chip and as one of the "examples".
  filePath: string;
  isPublic: boolean;
  source: {
    kind: "shadcn-customised" | "custom";
    // For shadcn customisations: what we changed from the default. Brief.
    notes?: string;
  };
  // Other components this one composes. Used for the "Built from" chip.
  composedOf?: string[];
  // 1-2 short sentences on accessibility — keyboard support, aria
  // patterns, focus behaviour. Optional.
  a11y?: string;
  // Representative usage paths — not exhaustive. The component's own
  // filePath is implicit so we don't repeat it.
  examples?: string[];
  // Which variants/sizes are actually USED in the public app — every
  // variant/size in the demo is shown, but used ones get an "in use"
  // marker. Anything not listed here is assumed available but unused.
  // Surveyed by reading callsites in components/*.tsx (excluding admin
  // and DS code itself). Numerical state, so it can drift — re-survey
  // when the codebase changes shape.
  usedVariants?: string[];
  usedSizes?: string[];
};

// --- Atoms -----------------------------------------------------------
// Single-purpose primitives with no domain knowledge. Most are shadcn
// customisations.
export const atoms: ComponentEntry[] = [
  {
    id: "button",
    name: "Button",
    description:
      "Interactive trigger. The most-used component in the app. Six variants × eight sizes via class-variance-authority, plus an `asChild` slot pattern for wrapping non-button trigger elements.",
    filePath: "components/ui/button.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes:
        "Bespoke `xs` and `icon-xs` sizes; rounded-4xl by default (pill shape) instead of shadcn's rounded-md; hover:scale-102 + active:translate-y-px micro-interactions on the default variant.",
    },
    composedOf: ["radix-ui Slot (for asChild)"],
    a11y:
      "Native <button> semantics. Focus-visible ring keyed to --ring. Disabled blocks pointer events.",
    examples: ["components/photo-overlay.tsx", "components/confirm-dialog.tsx", "components/help-button.tsx"],
    // Surveyed across filter-panel, photo-overlay, theme-toggle,
    // help-button, confirm-dialog. Most variants/sizes ship in the
    // CVA but aren't actually called by the public app yet.
    usedVariants: ["default", "outline", "ghost", "destructive"],
    usedSizes: ["default", "xs", "sm", "icon"],
  },
  {
    id: "checkbox",
    name: "Checkbox",
    description:
      "Toggleable boolean with an animated tick that draws on check and erases on uncheck. Used in the rating filter and admin form panels.",
    filePath: "components/ui/checkbox.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes:
        "Custom checkmark animation (stroke-dashoffset keyframes injected via inline <style>); HugeiconsIcon Tick02 instead of the lucide check; size-4 (smaller than shadcn default).",
    },
    composedOf: ["radix-ui Checkbox", "@hugeicons/react Tick02Icon"],
    a11y: "Radix Checkbox. Space toggles; aria-checked reflects state.",
    examples: ["components/filter-panel.tsx"],
  },
  {
    id: "input",
    name: "Input",
    description:
      "Single-line text input with a built-in clear (X) button that appears whenever the input is controlled and non-empty. Wrapper structure stays constant whether the button is visible or not — earlier conditional rendering caused focus loss on first keystroke. No size variants; for a smaller input, build a CVA wrapper.",
    filePath: "components/ui/input.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes:
        "Adds the integrated clear button. Uses rounded-lg (8px) instead of rounded-md to match the search-bar look. Placeholder rendered at muted-foreground/60.",
    },
    a11y:
      "Native <input>. Clear button has aria-label \"Clear\". focus-visible ring matches Button.",
    // Public usage: the friend + primary station picker dropdowns
    // (placeholder strings: \"Other London stations\" / \"Other stations\").
    // SearchBar wraps Input but is only mounted in admin mode.
    examples: ["components/filter-panel.tsx (Other London / Other stations pickers)"],
  },
  {
    id: "label",
    name: "Label",
    description:
      "Form label that pairs with an input via htmlFor. Goes opaque + cursor-not-allowed when its sibling input is disabled, via peer-disabled selectors. No size variants — single text-sm style throughout.",
    filePath: "components/ui/label.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes: "Minor — adds flex+gap-2 so labels naturally lay out icon + text side-by-side.",
    },
    composedOf: ["radix-ui Label"],
    a11y: "Radix Label propagates click to the associated input automatically.",
    // Public usage: the \"Direct trains only\" checkbox label inside
    // the filter panel (filter-panel.tsx:1336, rendered when
    // !adminMode). All other Label usages in the app are admin-only.
    examples: ["components/filter-panel.tsx (\"Direct trains only\" checkbox)"],
  },
  {
    id: "slider",
    name: "Slider",
    description:
      "Range input. Two-handled by default (min/max). Per-part className overrides (track/range/thumb) and a thumbContent slot let the travel-time slider replace the default circle thumb with a train icon and overlay a train-track pattern on the range.",
    filePath: "components/ui/slider.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes:
        "Slot system for per-part className overrides; thumbContent prop; rounded-4xl track and thumb to fit the rest of the system.",
    },
    composedOf: ["radix-ui Slider"],
    a11y: "Radix Slider. Arrow keys move thumbs; PageUp/PageDown for big jumps; Home/End for min/max.",
    examples: ["components/filter-panel.tsx"],
  },
  {
    id: "tooltip",
    name: "Tooltip",
    description:
      "Floating hint that appears on hover or focus. Mounted via a single TooltipProvider in app/layout.tsx — individual usages just wrap their trigger in <Tooltip><TooltipTrigger /><TooltipContent /></Tooltip>.",
    filePath: "components/ui/tooltip.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes: "Standard shadcn — minor styling tweaks only.",
    },
    composedOf: ["radix-ui Tooltip"],
    a11y:
      "Radix Tooltip. Triggered on hover AND focus, dismissed on Escape. Content is announced as a tooltip role.",
    examples: ["components/help-button.tsx", "components/filter-panel.tsx"],
  },
  {
    id: "dialog",
    name: "Dialog",
    description:
      "Modal overlay with a focus trap. Composed of multiple parts (Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose) so consumers control which subcomponents to render.",
    filePath: "components/ui/dialog.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes:
        "Includes a built-in close button rendered via the Button component (size icon-xs); customised overlay backdrop animation.",
    },
    composedOf: ["radix-ui Dialog", "Button (close)", "@hugeicons Cancel01Icon"],
    a11y:
      "Radix Dialog: focus trapped while open, ESC closes, focus returns to trigger on close. DialogTitle is announced as the dialog's accessible name.",
    examples: ["components/photo-overlay.tsx", "components/confirm-dialog.tsx"],
  },
  {
    id: "dropdown-menu",
    name: "DropdownMenu",
    description:
      "Trigger + portal-rendered menu of items. Used by the filter panel for the Feature, Interchange and Season dropdowns. Supports nested submenus, separators, and item icons.",
    filePath: "components/ui/dropdown-menu.tsx",
    isPublic: true,
    source: {
      kind: "shadcn-customised",
      notes: "Standard shadcn — minor padding tweaks.",
    },
    composedOf: ["radix-ui DropdownMenu"],
    a11y:
      "Radix DropdownMenu. Arrow keys navigate items; typeahead jumps to first match; ESC closes.",
    examples: ["components/filter-panel.tsx"],
  },
  {
    id: "theme-toggle",
    name: "ThemeToggle",
    description:
      "Single icon button that toggles between light and dark mode via next-themes. Force-locks light mode on mobile (matchMedia listener) because the main app's mobile experience doesn't ship dark styling.",
    filePath: "components/theme-toggle.tsx",
    isPublic: true,
    source: { kind: "custom" },
    composedOf: ["Button"],
    a11y: "<Button> with aria-label \"Toggle dark mode\".",
    examples: ["app/page.tsx"],
  },
  {
    id: "logo-spinner",
    name: "LogoSpinner",
    description:
      "Compact loading indicator built from the brand glyph — a stylised steam-locomotive driving wheel with a coupling rod that orbits in lockstep. The orbit motion is pure translate (compositor-friendly) so it keeps moving even when the main thread is blocked by route computations.",
    filePath: "components/logo-spinner.tsx",
    isPublic: true,
    source: { kind: "custom" },
    a11y: "Decorative — surrounding context (e.g. \"Loading…\") provides the announcement.",
    examples: ["components/welcome-banner.tsx"],
  },
  {
    id: "help-button",
    name: "HelpButton",
    description:
      "Circular icon button that opens a help tooltip on hover/focus. Floats over the map at top-right; opens a longer-form help dialog on click.",
    filePath: "components/help-button.tsx",
    isPublic: true,
    source: { kind: "custom" },
    composedOf: ["Button", "Tooltip"],
    a11y: "Button with aria-label \"Help\". Tooltip provides the on-hover hint.",
    examples: ["components/map.tsx"],
  },
];

// --- Molecules ------------------------------------------------------
// Generic patterns that compose atoms. Shape is reusable, only data is app-specific.
export const molecules: ComponentEntry[] = [
  {
    id: "confirm-dialog",
    name: "ConfirmDialog",
    description:
      "Modal that asks the user to confirm an irreversible action. Generic — takes a title, body, and confirm/cancel labels. Currently only used by admin-only flows (RamblerExtrasEditor in photo-overlay; walks-admin-panel) so it's hidden from the DS until a public flow needs it.",
    filePath: "components/confirm-dialog.tsx",
    // Only used in admin-only callsites today. Keep the entry so the
    // pattern is documented but exclude it from the public DS surface.
    isPublic: false,
    source: { kind: "custom" },
    composedOf: ["Dialog", "Button"],
    a11y: "Inherits Dialog's focus trap. Default focus on Cancel so a stray Enter doesn't trigger destructive action.",
    examples: ["components/walks-admin-panel.tsx", "components/photo-overlay.tsx"],
  },
  {
    id: "search-bar",
    name: "SearchBar",
    description:
      "Text input with a result-suggestion dropdown. Generic enough that the suggestion source can be any list of items; in this app it's wired to the station list. Currently only mounted inside the filter panel's admin-mode block — hidden from the DS until a public usage exists.",
    filePath: "components/search-bar.tsx",
    // Mounted only inside `{adminMode && (...)}` in filter-panel.tsx.
    isPublic: false,
    source: { kind: "custom" },
    composedOf: ["Input", "DropdownMenu"],
    a11y: "Input has a search role; dropdown items navigable by arrow keys.",
    examples: ["components/filter-panel.tsx (admin-only block)"],
  },
];

// --- Macromolecules -------------------------------------------------
// Domain-specific regions of the screen.
export const macromolecules: ComponentEntry[] = [
  {
    id: "filter-panel",
    name: "FilterPanel",
    description:
      "The whole left rail of station filters. Knows what fields exist (rating checkboxes, travel-time slider, feature dropdowns, season picker) and the rules tying them together. Lift it out of this app and the structure stops making sense.",
    filePath: "components/filter-panel.tsx",
    isPublic: true,
    source: { kind: "custom" },
    composedOf: ["SearchBar", "Slider", "Checkbox", "DropdownMenu", "Tooltip", "Button"],
    a11y: "Each subcomponent inherits its own a11y. Section labels group related controls visually.",
  },
  {
    id: "welcome-banner",
    name: "WelcomeBanner",
    description:
      "First-visit intro modal. Specific to this product — explains what Trains to Green is, shows a sample station, dismisses to localStorage so it only appears once.",
    filePath: "components/welcome-banner.tsx",
    isPublic: true,
    source: { kind: "custom" },
    // Custom modal (not built on Dialog) — implements its own
    // backdrop + animation chain because the entrance/exit animates
    // out from the help-button position. Uses LogoSpinner during the
    // initial map-data computation.
    composedOf: ["LogoSpinner"],
    examples: ["app/page.tsx"],
  },
];

// --- Organelles -----------------------------------------------------
// Complete UI subsystems.
export const organelles: ComponentEntry[] = [
  {
    id: "photo-overlay",
    name: "PhotoOverlay",
    description:
      "The station detail modal — the main user destination after clicking a station on the map. Composes a header, journey panel, walks list, photo carousel, and admin sub-panels into one full-screen modal experience.",
    filePath: "components/photo-overlay.tsx",
    isPublic: true,
    source: { kind: "custom" },
    composedOf: ["Dialog", "Button", "Slider", "Tooltip", "Checkbox", "Input"],
    a11y:
      "Inherits Dialog's focus trap and ESC close. Header reads as the dialog's accessible name.",
  },
];

// --- Helpers ----------------------------------------------------------
// Tier metadata used by the landing page and per-tier pages. Keeping it
// here so adding a new tier means adding it in one place.
export type Tier = "atoms" | "molecules" | "macromolecules" | "organelles";

export const tierInfo: Record<
  Tier,
  { name: string; tagline: string; definition: string; test: string; builtOn: string }
> = {
  atoms: {
    name: "Atoms",
    tagline: "Primitives",
    definition:
      "Single-purpose UI elements with their own state and no domain knowledge.",
    test: "Would this look and behave identically in any other product?",
    builtOn: "A single HTML element or library primitive (shadcn / Radix).",
  },
  molecules: {
    name: "Molecules",
    tagline: "Patterns",
    definition:
      "Reusable compositions that solve a recurring UI need — collect a value, confirm an action, pick from suggestions. They receive app-specific data via props, but their structure travels.",
    test: "Would this file work in a different project as-is, given different data?",
    builtOn: "Atoms.",
  },
  macromolecules: {
    name: "Macromolecules",
    tagline: "Domain regions",
    definition:
      "Compositions whose structure encodes this product's domain. A macromolecule knows which fields and controls belong, in what order, and why.",
    test: "Would the shape make sense in a totally different product?",
    builtOn: "Molecules, atoms, occasionally other macromolecules.",
  },
  organelles: {
    name: "Organelles",
    tagline: "Subsystems",
    definition:
      "Complete UI experiences — a modal flow, a full screen, a major feature region. The largest reusable unit before \"the whole app\".",
    test: "Does it read more like a \"view\" or \"modal\" than a \"component\"?",
    builtOn: "Macromolecules, molecules, atoms.",
  },
};
