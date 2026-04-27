/**
 * Non-colour token registry for the DS app.
 *
 * Like lib/design-system/colors.ts, this file holds METADATA only —
 * the actual values come from CSS at runtime via getComputedStyle.
 * That keeps the DS in sync with globals.css with zero duplication.
 *
 * Structure: each section is its own array because the visualisations
 * differ (a spacing bar isn't a radius square isn't an animation
 * demo). The page renders each array with the matching component.
 */

// Common shape for every token entry. Keeps things explicit while
// allowing each section to add its own visualisation logic.
export type TokenEntry = {
  cssVar: string;          // e.g. "--radius-md"
  name?: string;           // optional display override
  description?: string;
  isPublic: boolean;
  // Public callsites where this token is consumed. Used by the
  // visualisation cards to show "where in the app does this actually
  // show up?". Empty array = registered but unused (a finding worth
  // noting). Undefined = the registry hasn't been populated for this
  // token yet (don't render a usage section).
  usedIn?: string[];
};

// All non-colour tokens live in the same source file as the colours.
export const TOKENS_SOURCE_FILE = "app/globals.css";

// --- Spacing ----------------------------------------------------------
// Tailwind v4 derives every `p-1`, `m-2`, `gap-3` etc. from
// `--spacing` — multiply the index by the base. So a single token
// drives the entire spacing scale.
export const spacingTokens: TokenEntry[] = [
  {
    cssVar: "--spacing",
    isPublic: true,
    description:
      "Base unit Tailwind multiplies by the utility index — p-1 = 1×, gap-2 = 2×, mt-4 = 4×. Bumped on mobile (≤639.98px) so padding feels proportional on small screens.",
  },
  {
    cssVar: "--para-gap",
    isPublic: true,
    description:
      "Vertical gap between paragraphs inside the photo-overlay journey-info region — one knob to retune in-modal paragraph spacing globally.",
  },
];

// --- Border radius ----------------------------------------------------
// All --radius-* tokens are calc() multipliers of --radius. Editing
// the base re-tunes the entire app's roundness in one place.
// Public usage surveyed by grepping `rounded-*` class strings across
// non-admin / non-DS code (components/*.tsx, components/ui/*.tsx,
// app/page.tsx, app/layout.tsx). The lists below tell each radius
// card "where in the public app you'll see this corner shape" so it's
// not just an abstract token.
export const radiusTokens: TokenEntry[] = [
  {
    cssVar: "--radius",
    isPublic: true,
    description:
      "Base radius — every other --radius-* token is a calc() of this. The bare `rounded` utility (no suffix) maps here in Tailwind v4.",
    // `rounded` (no suffix) is widespread — too many to itemise, so
    // we summarise. The specific sizes below cover the named tiers.
    usedIn: ["Many — every `rounded` (no suffix) class resolves to this"],
  },
  {
    cssVar: "--radius-sm",
    isPublic: true,
    description: "0.6× base. Used by `rounded-sm`.",
    usedIn: ["components/ui/dropdown-menu.tsx"],
  },
  {
    cssVar: "--radius-md",
    isPublic: true,
    description: "0.8× base. Used by `rounded-md`.",
    usedIn: [
      "components/ui/dropdown-menu.tsx",
      "components/photo-overlay.tsx",
      "components/filter-panel.tsx",
    ],
  },
  {
    cssVar: "--radius-lg",
    isPublic: true,
    description: "1.0× base. Used by `rounded-lg`. The most common explicit size in the app — the default for most card surfaces.",
    usedIn: [
      "components/ui/input.tsx",
      "components/welcome-banner.tsx",
      "components/search-bar.tsx",
      "components/photo-overlay.tsx",
      "components/filter-panel.tsx",
    ],
  },
  {
    cssVar: "--radius-xl",
    isPublic: true,
    description: "1.4× base. Used by `rounded-xl`.",
    usedIn: ["components/welcome-banner.tsx (card outer)"],
  },
  {
    cssVar: "--radius-2xl",
    isPublic: true,
    description: "1.8× base. Used by `rounded-2xl`.",
    usedIn: ["components/ui/tooltip.tsx (bubble)"],
  },
  {
    cssVar: "--radius-3xl",
    isPublic: true,
    description: "2.2× base. Used by `rounded-3xl`.",
    // Empty array — registered in globals.css but no public callsite
    // currently consumes it. Surfaced as anomaly r3un.
    usedIn: [],
  },
  {
    cssVar: "--radius-4xl",
    isPublic: true,
    description: "2.6× base. Used by `rounded-4xl` — the pill / capsule shape. Default for the Button component.",
    usedIn: [
      "components/ui/button.tsx (default for every variant)",
      "components/ui/dialog.tsx (modal content)",
      "components/ui/slider.tsx (track + thumb)",
      "components/ui/tooltip.tsx (kbd children)",
    ],
  },
];

// --- Breakpoints ------------------------------------------------------
// Tailwind v4 defaults — not declared in globals.css, but they're the
// thresholds the app's own media queries (and every Tailwind variant
// like md:, lg:, etc.) lock onto. We list them as tokens so the DS
// surfaces them, even though they aren't CSS variables.
export type BreakpointEntry = {
  name: string;            // "sm" | "md" | "lg" | "xl" | "2xl"
  minWidth: number;        // px
  description?: string;
};

// Frequency tally + "what flips here" notes are surveyed by grepping
// `sm:`, `md:`, `lg:`, `xl:`, `2xl:` across non-admin / non-DS code.
// The numbers will drift as the codebase grows — re-run the grep when
// they feel stale. The point of recording them is to highlight the
// reality that this app is mobile-first with one big break at sm and
// one minor one at md; lg / xl / 2xl are essentially unused.
export const breakpoints: BreakpointEntry[] = [
  {
    name: "sm",
    minWidth: 640,
    description:
      "The dominant breakpoint — does most of the mobile↔desktop work. Above sm: filter panel becomes a fixed-width sidebar (was full-width pill); welcome banner stops sliding from the bottom; photo-overlay shifts from full-screen sheet to centred modal; many cards add padding. ~52 occurrences across 9 files.",
  },
  {
    name: "md",
    minWidth: 768,
    description:
      "Theme toggle becomes visible (hidden md:block in app/page.tsx). Root font-size drops from 20px to 17px (globals.css media query). Photo-overlay tweaks a few hover states. ~7 occurrences total — much rarer than sm.",
  },
  {
    name: "lg",
    minWidth: 1024,
    description:
      "Essentially unused in this app — fewer than 5 occurrences, all minor adjustments. The desktop layout is settled by md.",
  },
  {
    name: "xl",
    minWidth: 1280,
    description:
      "Unused in public app code. The mobile-first design pattern doesn't reach this far up.",
  },
  {
    name: "2xl",
    minWidth: 1536,
    description:
      "Unused. Listed for completeness — these are Tailwind's defaults and `2xl:` would work if you wrote it, but no callsites do.",
  },
];

// --- Root font size --------------------------------------------------
// The html element's font-size changes at the md breakpoint (see the
// @media block in globals.css). 1rem == this size, so it indirectly
// scales the entire app.
export const rootFontSizeNote = {
  mobile: "20px",
  tabletAndUp: "17px",
  threshold: "768px (md breakpoint)",
};

// --- Animations -------------------------------------------------------
// Each entry knows which CSS variable defines the animation shorthand
// (or, for keyframes referenced indirectly like `orbit`, the keyframe
// name) and which Tailwind utility activates it. The visualisation
// component picks one and renders a live demo.
export type AnimationEntry = {
  name: string;            // "shimmer" | "orbit"
  // The shorthand CSS variable, e.g. "--animate-shimmer". Resolved at
  // runtime so the demo applies the same animation the rest of the
  // app uses. Optional because some keyframes (orbit) are activated
  // via the `animation` shorthand inline rather than a token.
  cssVar?: string;
  // Inline CSS used by the demo to trigger the animation. We have to
  // hand-write this because Tailwind doesn't surface --animate-* tokens
  // as utility classes outside the theme block.
  inlineAnimation: string;
  description?: string;
  isPublic: boolean;
};

export const animationTokens: AnimationEntry[] = [
  {
    name: "shimmer",
    cssVar: "--animate-shimmer",
    inlineAnimation: "shimmer 1.6s ease-in-out infinite",
    description:
      "Slides a gradient strip left-to-right across loading skeletons. The keyframe is defined at the bottom of globals.css.",
    isPublic: true,
  },
  {
    name: "orbit",
    inlineAnimation: "orbit 1.6s linear infinite",
    description:
      "Coupling-rod orbit used by the welcome-banner spinner. 12-step keyframe samples a circle every 30°. Compositor-friendly so it keeps moving even when the main thread is busy.",
    isPublic: true,
  },
];
