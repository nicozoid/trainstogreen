/**
 * Motion registry — every meaningful animation in the app, grouped
 * by what the motion COMMUNICATES rather than where it's
 * implemented.
 *
 * Motion isn't tokenised in this codebase: durations and easings
 * live as inline values across CSS keyframes, tw-animate-css class
 * strings, Tailwind transition utilities, manual setTimeout chains,
 * Mapbox layer transitions, and rAF loops. So this registry is
 * curated by hand — each entry calls out the exact source location
 * so we can spot inconsistencies between similar effects.
 *
 * The page renders entries grouped by category. Putting related
 * animations next to each other is what makes inconsistencies
 * visible: two modal openings with different durations on the same
 * row, etc.
 */

export type MotionCategory =
  | "loading"
  | "modal"
  | "state"
  | "map"
  | "feedback";

export type MotionType =
  | "css-keyframe"        // declared in globals.css with @keyframes
  | "tw-animate-css"      // class strings like animate-in fade-in-0 zoom-in-95
  | "tailwind-transition" // class strings like transition-* duration-*
  | "manual-timer"        // setTimeout-driven class swap (welcome banner)
  | "js-raf"              // requestAnimationFrame loop
  | "mapbox";             // Mapbox layer transitions / paint changes

// One direction of a multi-phase animation. Used when an animation
// has distinct entry vs exit (or draw vs erase) timings — keeps the
// values from getting mashed together on the card.
export type MotionPhase = {
  label: string;     // e.g. "Entry", "Exit", "Draw", "Erase", "Open", "Close"
  duration: string;
  easing: string;
};

export type MotionEntry = {
  // Stable identifier — used as React key + URL anchor.
  id: string;
  name: string;
  category: MotionCategory;
  // What causes it (e.g. "Dialog open prop flips", "Hover", "rAF loop").
  trigger: string;
  type: MotionType;
  // For single-direction animations: top-level duration + easing.
  // Plain text values, exactly as they appear in the source — we
  // surface them verbatim so consistency-checking compares like with
  // like. Set to undefined when `phases` is used instead.
  duration?: string;
  easing?: string;
  // For multi-direction animations (entry/exit, draw/erase, open/close):
  // an ordered list of phases with their own duration + easing. The
  // page renders each phase as its own subsection with a divider so
  // the values aren't mixed up on the card.
  phases?: MotionPhase[];
  // file:line if the value is in one place, or "many" with notes
  // when it's a Tailwind utility scattered across callsites.
  source: string;
  description: string;
  isPublic: boolean;
};

// --- Display metadata ----------------------------------------------
export const motionCategoryInfo: Record<
  MotionCategory,
  { name: string; description: string }
> = {
  loading: {
    name: "Loading & in-progress",
    description:
      "Continuous, looping motion that signals the app is busy. Should feel alive without demanding attention.",
  },
  modal: {
    name: "Modal entry & exit",
    description:
      "Overlays, dialogs and full-screen modals appearing and dismissing. The most-watched group for consistency — every modal in the app should feel like the same kind of moment.",
  },
  state: {
    name: "State changes within a component",
    description:
      "Transitions between two states of the same element — checked/unchecked, expanded/collapsed, hovered/not. Faster than modal motion; usually under 200ms.",
  },
  map: {
    name: "Map reveals",
    description:
      "Markers and routes appearing or fading on the Mapbox layer. Driven by Mapbox's own paint-property transitions or by Tailwind opacity wrappers around map UI.",
  },
  feedback: {
    name: "Micro-feedback",
    description:
      "Small responses to interaction — focus rings, link underlines, dropdown openings, slider knob travel. Often the same handful of durations repeated.",
  },
};

// --- The registry --------------------------------------------------
// Roughly ordered: most user-visible / most actionable first within
// each category.
export const motionEntries: MotionEntry[] = [
  // ------- LOADING -----------------------------------------------------
  {
    id: "shimmer",
    name: "Shimmer skeleton",
    category: "loading",
    trigger: "Element has `animate-shimmer` applied (loading skeletons during data fetches).",
    type: "css-keyframe",
    duration: "1.6s",
    easing: "ease-in-out",
    source: "app/globals.css — @keyframes shimmer",
    description:
      "Sweeping gradient strip that translates left-to-right across a muted block, suggesting that the block is a placeholder.",
    isPublic: true,
  },
  {
    id: "orbit",
    name: "Logo spinner orbit",
    category: "loading",
    trigger: "LogoSpinner component is rendered.",
    type: "css-keyframe",
    duration: "0.8s",
    easing: "linear",
    source: "app/globals.css — @keyframes orbit; components/logo-spinner.tsx:68",
    description:
      "Coupling rod tracing a small circle between the spinner's two wheels. Compositor-friendly translate-only — keeps moving even when the main thread is blocked.",
    isPublic: true,
  },

  // ------- MODAL ------------------------------------------------------
  {
    id: "dialog-enter",
    name: "Dialog (Radix) entry",
    category: "modal",
    trigger: "Dialog open prop flips to true.",
    type: "tw-animate-css",
    duration: "100ms (content) / 200ms (backdrop)",
    easing: "tw-animate-css default (linear-ish)",
    source: "components/ui/dialog.tsx:43 (overlay), :71 (content)",
    description:
      "Backdrop fades in over 200ms while the content fades + zooms-in (95% → 100%) over 100ms. Standard shadcn/Radix pattern, used for ConfirmDialog and any inline Dialog.",
    isPublic: true,
  },
  {
    id: "welcome-banner-entry-exit",
    name: "Welcome banner entry & exit",
    category: "modal",
    trigger:
      "Help button clicked (entry); X / backdrop / Escape clicked (exit). The trigger element's screen position is passed in as originX / originY.",
    type: "manual-timer",
    phases: [
      {
        label: "Entry",
        duration: "400ms",
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      {
        label: "Exit",
        duration: "260ms (0.65 × 400ms)",
        easing: "cubic-bezier(0.4, 0, 1, 1)",
      },
    ],
    source: "components/welcome-banner.tsx:118-180",
    description:
      "Grows out of and shrinks back into the trigger element's screen position. Done by translating the modal from the trigger's centre to viewport-centre on entry, scaling 0.02 → 1, and reversing both on exit. The DS demo captures the click position from the trigger button so the animation is fully working — open the banner from different positions on the page to see it fly out of each one.",
    isPublic: true,
  },
  {
    id: "station-modal-entry-exit",
    name: "Station modal entry & exit",
    category: "modal",
    trigger:
      "Station marker clicked (entry); X / Escape (exit). The marker's screen position is passed as originX / originY.",
    type: "manual-timer",
    phases: [
      {
        label: "Entry",
        duration: "400ms",
        easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      {
        label: "Exit",
        duration: "260ms (0.65 × 400ms) / 300ms",
        easing: "cubic-bezier(0.4, 0, 1, 1) / ease",
      },
    ],
    source: "components/photo-overlay.tsx:986-1058",
    description:
      "Same fly-in / fly-out pattern as the welcome banner. The modal grows out of the clicked station marker and shrinks back to the same point on close. Internal timing is inconsistent: some sub-elements use cubic-bezier, one uses plain `ease forwards` — see anomaly m1ex.",
    isPublic: true,
  },
  {
    id: "dropdown-menu-open-close",
    name: "Dropdown menu open & close",
    category: "modal",
    trigger: "Trigger clicked or focused-then-Enter; click outside / Escape to close.",
    type: "tw-animate-css",
    phases: [
      {
        label: "Open",
        duration: "tw-animate-css default (~150ms)",
        easing: "tw-animate-css default",
      },
      {
        label: "Close",
        duration: "tw-animate-css default (~150ms)",
        easing: "tw-animate-css default",
      },
    ],
    source: "components/ui/dropdown-menu.tsx:21-23",
    description:
      "fade-in-0 + zoom-in-95 on data-[state=open]; matching fade-out-0 + zoom-out-95 on close. Same shape as Dialog content but no explicit duration override.",
    isPublic: true,
  },

  // ------- STATE ------------------------------------------------------
  {
    id: "checkbox-tick-draw-erase",
    name: "Checkbox tick — draw & erase",
    category: "state",
    trigger: "Checkbox toggles between checked and unchecked.",
    type: "css-keyframe",
    phases: [
      { label: "Draw", duration: "200ms", easing: "ease-out" },
      { label: "Erase", duration: "150ms", easing: "ease-in" },
    ],
    source: "components/ui/checkbox.tsx:14-29 — @keyframes checkmark-draw + checkmark-erase",
    description:
      "Stroke-dasharray animates the tick on (21 → 0) and off (0 → 21). Erase is faster than draw (150 vs 200ms), a deliberate asymmetry — removing feedback should feel quicker than introducing it. Click the demo to toggle and see both directions.",
    isPublic: true,
  },
  {
    id: "button-hover-scale",
    name: "Button hover — scale + press",
    category: "state",
    trigger: "Hover / active on the default Button variant.",
    type: "tailwind-transition",
    duration: "default Tailwind (150ms)",
    easing: "default Tailwind (cubic-bezier)",
    source: "components/ui/button.tsx:8 — `transition-all` + `hover:scale-102` + `active:translate-y-px`",
    description:
      "Tiny lift on hover (102% scale), tiny press on active (1px down). Subtle physical feedback that reads at a glance without being distracting.",
    isPublic: true,
  },
  {
    id: "filter-icon-jump",
    name: "Rating-row icon jump",
    category: "state",
    trigger: "User clicks a rating-row label (Sublime, Charming, Pleasant, Flawed, Unknown) inside the filter panel.",
    type: "manual-timer",
    duration: "Up: instant; back down: 150ms",
    easing: "ease-out",
    source: "components/filter-panel.tsx:34-104 — LabelTip + setJumped",
    description:
      "Tiny micro-interaction: when a rating row is tapped, its icon hops up 3px instantly (transform: translateY(-3px)), then a 120ms setTimeout flips a state flag and the CSS transition eases it back down over 150ms. Snappy on the way up, soft on the way down — communicates 'noted' without stealing attention.",
    isPublic: true,
  },
  {
    id: "filter-panel-collapse",
    name: "Filter panel collapse / expand",
    category: "state",
    trigger: "Logo + chevron header row clicked (public; available on every viewport).",
    type: "tailwind-transition",
    duration: "300ms",
    easing: "ease-in-out",
    source: "components/filter-panel.tsx:921",
    description:
      "Grid-template-rows animation — the panel's body collapses to 0 rows then back to auto. Smooth but slower than other state changes; the larger surface justifies the longer duration. Not admin-gated: every user can collapse the panel.",
    isPublic: true,
  },
  {
    id: "filter-panel-chevron",
    name: "Collapse-chevron rotate",
    category: "state",
    trigger: "Same as filter-panel-collapse (paired).",
    type: "tailwind-transition",
    duration: "200ms",
    easing: "default Tailwind",
    source: "components/filter-panel.tsx:910",
    description:
      "Chevron icon rotates 0° ↔ 180°. Faster than the body collapse so the rotation completes first — visually leads the panel motion.",
    isPublic: true,
  },

  // ------- MAP --------------------------------------------------------
  {
    id: "map-fade-in",
    name: "Map UI element fade-in",
    category: "map",
    trigger: "Map UI elements (overlays, controls) entering view.",
    type: "tailwind-transition",
    duration: "700ms",
    easing: "default Tailwind",
    source: "components/map.tsx:9665, :9709",
    description:
      "Long fade — 700ms is the slowest interaction-driven motion in the app. Used for the help/dev controls that float over the map, where a slower fade reads as 'gently appearing' rather than 'snapping in'.",
    isPublic: true,
  },
  {
    id: "map-hover-glow",
    name: "Hovered station glow pulse",
    category: "map",
    trigger: "Pointer enters a station marker.",
    type: "js-raf",
    duration: "Continuous (driven by rAF)",
    easing: "Computed per-frame",
    source: "components/map.tsx — hover handler + rAF loop",
    description:
      "Soft green ring (#22c55e) around the marker, opacity oscillating 0.3 ↔ 0.75. Animated via requestAnimationFrame instead of CSS keyframes so it can pause cleanly the moment the hover ends.",
    isPublic: true,
  },
  {
    id: "map-polyline-draw",
    name: "Route polyline reveal",
    category: "map",
    trigger: "User clicks a station — the route from London draws in.",
    type: "mapbox",
    duration: "Mapbox internal (~300ms transition on line-opacity)",
    easing: "Mapbox default",
    source: "components/map.tsx — line-paint transitions",
    description:
      "The journey line for a clicked station fades in via Mapbox's built-in paint transition on line-opacity. Not a stroke-dasharray draw — just an opacity ramp.",
    isPublic: true,
  },

  // ------- FEEDBACK ---------------------------------------------------
  {
    id: "transition-opacity-default",
    name: "Generic opacity transition (banners, toasts)",
    category: "feedback",
    trigger: "Mounted/unmounted with a class swap.",
    type: "tailwind-transition",
    duration: "300ms",
    easing: "default Tailwind",
    source: "components/admin-toast-pill.tsx:43, components/admin-offline-banner.tsx:32",
    description:
      "Used by the admin toast pill and offline banner to fade their visibility. Both admin-only — but the timing pattern is the canonical 'medium' fade in this codebase.",
    isPublic: false, // admin-only callsites
  },
  {
    id: "photo-hover-overlay",
    name: "Photo card hover overlay",
    category: "feedback",
    trigger: "Pointer enters a photo card.",
    type: "tailwind-transition",
    duration: "150ms",
    easing: "default Tailwind",
    source: "components/photo-overlay.tsx:2467, :2501, :2544, :2609",
    description:
      "Image opacity dims, action buttons slide/fade in, caption gradient slides up. All on the same 150ms — short and snappy because the user's already pointed at the card.",
    isPublic: true,
  },
  {
    id: "breakpoint-marker-slide",
    name: "Breakpoint-strip marker slide (DS-only)",
    category: "feedback",
    trigger: "Viewport resize.",
    type: "tailwind-transition",
    duration: "150ms",
    easing: "default Tailwind",
    source: "components/design-system/breakpoint-strip.tsx:87",
    description:
      "Thin vertical tick on the Layout-tokens page slides smoothly to track the current viewport width. DS-only, but useful because it demonstrates a slide pattern with the same 150ms baseline as photo hovers.",
    isPublic: false, // lives in DS app itself
  },
];
