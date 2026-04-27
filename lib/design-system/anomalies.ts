/**
 * Anomalies registry — places in the codebase where the design
 * system isn't being followed. We call them "anomalies" rather than
 * "deviations" because some may be intentional choices, not bugs.
 *
 * Each entry has a stable 4-character base36 code (same format as
 * walk IDs in scripts/assign-walk-ids.mjs) so the user can reference
 * one in conversation: "let's fix c7kq". The codes are
 * hand-assigned and stable — never reuse a code, never rename one.
 *
 * If you fix an anomaly, mark its status "fixed" so the entry stays
 * in the registry as a record. Fully removing entries makes the
 * codes ambiguous — "did c7kq get fixed or did it never exist?"
 */

export type AnomalyCategory =
  | "color"
  | "typography"
  | "structure"
  | "iconography"
  | "motion"
  | "external";

export type AnomalyStatus =
  | "open"        // surfaced, no decision yet
  | "intentional" // confirmed deliberate, leave alone
  | "todo"        // agreed to fix at some point
  | "fixed";      // resolved, kept in the registry as a record

// Who first noticed this. "system" anomalies came out of automated
// surveys (grep, build-time checks, AI review). "human" anomalies
// were noticed by the designer/dev directly. The distinction is
// rendered as a pill so the source of the observation is visible.
export type AnomalyFlaggedBy = "system" | "human";

export type Anomaly = {
  // 4-character base36 — stable, never reused.
  id: string;
  // Short headline summarising the anomaly.
  title: string;
  // Bucket for grouping on the page.
  category: AnomalyCategory;
  status: AnomalyStatus;
  // Who first surfaced the anomaly. Defaults to "system" — set
  // explicitly to "human" for things the designer/dev noticed
  // directly. The page renders a distinct pill so the source is
  // visible.
  flaggedBy?: AnomalyFlaggedBy;
  // 1-2 sentences on what's wrong / different.
  description: string;
  // Where it occurs. Multiple locations means the same pattern
  // appears in several places — fix them together.
  locations: string[];
  // What it should be (or what to consider). Optional because some
  // anomalies are open questions, not prescribed fixes.
  fix?: string;
  // Notes the user may have added (e.g. "intentional because…").
  note?: string;
};

// --- The list -------------------------------------------------------
// Order: most actionable / numerous first. Status defaults to "open"
// for everything until the user reviews.
export const anomalies: Anomaly[] = [
  {
    id: "c7kq",
    title: "Welcome banner uses literal #161D37 for logo tint",
    category: "color",
    status: "open",
    description:
      "The welcome banner renders the brand wordmark by setting bg-[#161D37] on a CSS-masked div. The filter panel does the same thing but uses bg-primary. Two surfaces, two different colours, same shape — usually a mistake.",
    locations: ["components/welcome-banner.tsx:230"],
    fix: "Replace bg-[#161D37] with bg-primary (matching filter-panel.tsx) or pick a different token if the welcome banner intentionally needs a darker green.",
  },
  {
    id: "c7tg",
    title: "Map uses #2f6544 literal in 5 places instead of var(--tree-800)",
    category: "color",
    status: "open",
    description:
      "The London-terminus inner diamond and four polyline layers all paint with the literal hex #2f6544 — the same value as --tree-800. Using the variable would let dark mode (which redefines --tree-800) flow through automatically.",
    locations: [
      "components/map.tsx — London terminus inner diamond fill",
      "components/map.tsx — inter-terminal polyline (line-color)",
      "components/map.tsx — journey polyline (line-color)",
      "components/map.tsx — friend-journey polyline (line-color)",
      "components/map.tsx — radius circle outline (line-color)",
    ],
    fix: "Replace #2f6544 with the resolved value of --tree-800 read at runtime, or expose a dedicated --map-route token in globals.css.",
  },
  {
    id: "c7gl",
    title: "Hover-state glow uses #22c55e — no matching token exists",
    category: "color",
    status: "open",
    description:
      "Mapbox hover-glow circle is painted at the literal hex #22c55e (Tailwind green-500). There is no equivalent token in globals.css.",
    locations: ["components/map.tsx — hovered station glow paint"],
    fix: "Pick: alias to an existing token (--primary, --accent), introduce a new --hover-glow token, or accept the literal as a one-off.",
  },
  {
    id: "t9mu",
    title: "Three different opacities used for muted text intent",
    category: "typography",
    status: "open",
    description:
      "text-muted-foreground appears with /60, /70, and /80 modifiers in similar contexts (placeholder, hint, caption). The intent is the same — secondary copy — but the visual weight differs subtly.",
    locations: [
      "components/ui/input.tsx — placeholder uses /60",
      "components/filter-panel.tsx — disabled options use /70",
      "various — hints use /80 or no modifier",
    ],
    fix: "Pick one canonical opacity (likely /70 since it's the most common) and update the others, or add named tokens for each tier.",
  },
  {
    id: "t9rs",
    title: "text-sm font-semibold reused for two roles",
    category: "typography",
    status: "open",
    description:
      "The same class string is used for modal titles AND for section subheadings inside modals. Same visual weight, different semantic role — readers can't distinguish a primary heading from a sub-section by glance.",
    locations: [
      "components/welcome-banner.tsx — modal heading uses text-lg font-semibold",
      "components/photo-overlay.tsx — modal title uses text-lg font-semibold; subsection headings use text-sm font-semibold",
    ],
    fix: "Differentiate one of the roles — e.g. give modal titles a heavier weight, or de-emphasise subsection headings with text-sm font-medium. (Note: titles actually use text-lg and subheadings use text-sm — worth re-checking whether they're already distinct enough at those sizes.)",
    note: "Worth re-investigating — the original survey may have over-merged these.",
  },
  {
    id: "r3xl",
    title: "rounded-3xl is registered but no public callsite uses it",
    category: "structure",
    status: "open",
    description:
      "The --radius-3xl token is defined in globals.css's @theme inline block (alongside --radius-sm, -md, -lg, -xl, -2xl, -4xl) and the matching `rounded-3xl` Tailwind utility is generated. But no public component actually applies that class — every other size in the scale is used somewhere.",
    locations: [
      "globals.css — --radius-3xl: calc(var(--radius) * 2.2)",
      "(no public callsites)",
    ],
    fix: "Either remove --radius-3xl from the scale (it's a step nobody picks), or find a use for it. Low priority — the registration cost is just one calc().",
  },
  {
    id: "cfmb",
    title: "HelpButton and ThemeToggle share styling but exist as separate atoms",
    category: "structure",
    status: "open",
    flaggedBy: "human",
    description:
      "Both components are circular icon-only buttons with identical visual treatment — variant=\"outline\", size=\"icon\", bg-background/60 backdrop-blur-sm, hover:bg-background. Only the icon and onClick differ. The same className string is duplicated across the two atom files.",
    locations: [
      "components/help-button.tsx",
      "components/theme-toggle.tsx",
    ],
    fix: "Three options: (1) add a Button variant — e.g. variant=\"floating\" or variant=\"map-control\" — that captures the shared chrome, then HelpButton and ThemeToggle stay as separate atoms but pull styling from the variant; (2) make them a single Molecule (e.g. <MapControlButton>) that takes an icon + onClick, with HelpButton and ThemeToggle becoming compositions; (3) leave as-is and accept the duplication. Recommendation: option (1) — the styling difference is purely visual, not behavioural, which is exactly what variants are for. Behaviour stays separate (HelpButton's capture-origin pattern, ThemeToggle's mobile lock) so the two atoms still earn their own files.",
  },
  {
    id: "s2lg",
    title: "Logo aspect ratio cited inconsistently",
    category: "structure",
    status: "open",
    description:
      "Two callsites cite slightly different aspect-ratio numbers for the same logo SVG. The actual SVG viewBox is 597:51 — welcome-banner says 591:50, which would distort the logo at large sizes (though imperceptibly at the small sizes it's used).",
    locations: [
      "components/filter-panel.tsx — w-full aspect-[597/51] (correct)",
      "components/welcome-banner.tsx — aspectRatio: '591 / 50' (off)",
    ],
    fix: "Update welcome-banner.tsx to use 597 / 51.",
  },
  {
    id: "m2lc",
    title: "Map label colours are literal hex inside the Mapbox style JSON",
    category: "external",
    status: "open",
    description:
      "Station, county, and park labels all use literal hex colours like #166534 / #fdfcf8 / #6b7280 / #a1a1aa / #15803d / #86efac. They sit in Mapbox Studio rather than this codebase — fixing them means editing the published Mapbox style files, not searching the repo.",
    locations: [
      "Mapbox style mapbox://styles/niczap/cmneh11gr001q01qxeu1leyuc (light)",
      "Mapbox style mapbox://styles/niczap/cmnepmfm2001p01sfe63j3ktq (dark)",
    ],
    fix: "Update the label paint properties in Mapbox Studio to reference Mapbox's light/dark expressions, or accept these as out-of-band tokens that the DS won't manage.",
    note: "Lower priority — fix is two-step (Studio → publish → reload).",
  },
  {
    id: "m1ex",
    title: "Modal exit animations use mixed durations and easings",
    category: "motion",
    status: "open",
    description:
      "Modal-class components (welcome banner + station modal) implement their own exit animation via setTimeout. Within the same component the inline `animation:` properties switch between `ease forwards` and `cubic-bezier(0.4, 0, 1, 1) forwards`; durations are sometimes 260ms (0.65 × 400) and sometimes a flat 300ms. Two manual exit timers, three different timing values.",
    locations: [
      "components/welcome-banner.tsx:118 — uses `ease forwards`",
      "components/welcome-banner.tsx:124, 132, 141 — uses cubic-bezier",
      "components/photo-overlay.tsx:1006, 1021 — uses cubic-bezier",
      "components/photo-overlay.tsx:1058 — uses `300ms ease forwards`",
    ],
    fix: "Pick one canonical exit (likely cubic-bezier(0.4, 0, 1, 1) at 260ms since it's the dominant value) and apply it to every sub-element. Or extract a shared `EXIT_ANIMATION` constant.",
  },
  {
    id: "m2dur",
    title: "Modal entry durations differ across primitives",
    category: "motion",
    status: "open",
    description:
      "Three modal-class components, three different entry timings: Dialog content fades in over 100ms, Dialog backdrop over 200ms, WelcomeBanner backdrop over 200ms (with its content using tw-animate-css default), DropdownMenu uses tw-animate-css default. Without a baseline, modals feel out of sync with each other.",
    locations: [
      "components/ui/dialog.tsx:43 — duration-200 (overlay)",
      "components/ui/dialog.tsx:71 — duration-100 (content)",
      "components/welcome-banner.tsx:195 — duration-200",
      "components/ui/dropdown-menu.tsx:21-23 — no explicit duration",
    ],
    fix: "Pick a canonical 'modal-open' duration and apply it across all four. 200ms is already the most common value.",
  },
  {
    id: "m3dur",
    title: "transition-* utilities use 7+ ad-hoc durations",
    category: "motion",
    status: "open",
    description:
      "Across the codebase, Tailwind's transition-* utilities are paired with durations of 100, 150, 200, 300, 500, 700ms — and a few defaults. The intent is rough categorisation (snap, quick, medium, slow) but no convention enforces which to pick. Result: similar effects can land on different durations purely by which file they were written in.",
    locations: [
      "components/photo-overlay.tsx — uses 150ms for hover overlays",
      "components/admin-toast-pill.tsx, admin-offline-banner.tsx — 300ms",
      "components/welcome-banner.tsx:333 — 500ms (CTA opacity)",
      "components/map.tsx:9665, 9709 — 700ms (map UI fade)",
      "components/filter-panel.tsx:921 — 300ms (collapse)",
    ],
    fix: "Define a small, named scale — e.g. `motion-fast` (150ms), `motion` (200ms), `motion-slow` (300ms), `motion-very-slow` (700ms). Document each role on the Motion page.",
  },
];

// --- Display metadata ----------------------------------------------
export const categoryInfo: Record<
  AnomalyCategory,
  { name: string; description: string }
> = {
  color: {
    name: "Colour",
    description: "Hex / rgb literals, opacity drift, missing tokens.",
  },
  typography: {
    name: "Typography",
    description: "Inconsistent class strings or role/weight conflation.",
  },
  structure: {
    name: "Structure",
    description: "Layout, sizing, or spacing values that drift across callsites.",
  },
  iconography: {
    name: "Iconography",
    description: "Icon-library mixing, asset duplication, missing variants.",
  },
  motion: {
    name: "Motion",
    description: "Inconsistent durations or easings between similar effects.",
  },
  external: {
    name: "External",
    description: "Anomalies outside this codebase — Mapbox styles, third-party config.",
  },
};

export const statusInfo: Record<
  AnomalyStatus,
  { name: string; tone: "warn" | "info" | "good" | "muted" }
> = {
  open: { name: "Open", tone: "warn" },
  intentional: { name: "Intentional", tone: "muted" },
  todo: { name: "Todo", tone: "info" },
  fixed: { name: "Fixed", tone: "good" },
};
