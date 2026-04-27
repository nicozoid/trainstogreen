/**
 * Colour-token registry for the design-system mini-app.
 *
 * This file is the SINGLE SOURCE OF METADATA for every colour the DS app
 * displays — names, descriptions, isPublic flags, source-file locations.
 * The actual colour VALUES are NOT stored here: each swatch reads its
 * value from the live CSS via getComputedStyle at render time. That way
 * editing globals.css automatically updates the DS — no duplication, no
 * drift.
 *
 * Two top-level groups:
 *   semantic — tokens components actually use (e.g. --primary, --border).
 *              Each has a description of where/why it's used.
 *   raw      — the brand palette (e.g. --tree-800, --beach-500). Building
 *              blocks the semantic tokens point at.
 */

// One entry per colour variable. cssVar is the only required identifier;
// the human-readable `name` is derived from it (we strip the leading "--")
// but is overridable.
export type ColorToken = {
  cssVar: string;          // e.g. "--primary"
  name?: string;           // optional override; defaults to cssVar without "--"
  description?: string;    // where this token is used / what it represents
  // isPublic === false hides the token from the DS view. (No tokens are
  // currently admin-only, but the field is here so the rule applies
  // uniformly across colours, components, etc.)
  isPublic: boolean;
  // For semantic tokens that resolve to a raw token via var(...), we
  // record the alias chain in BOTH themes — most semantic tokens point
  // at different raw colours in light vs dark. The DS swatch displays
  // whichever entry matches the active theme. Undefined for raw tokens.
  alias?: {
    light: string;
    dark: string;
  };
};

// A subgroup is one band on the page (e.g. "Surface", "Foreground").
// Tokens are ordered as they appear in the array — pick the order
// thoughtfully because there's no auto-sort.
export type ColorGroup = {
  title: string;
  description?: string;
  tokens: ColorToken[];
};

// The file path is shared by every token below — recorded once so the
// DS UI can render a single "defined in: app/globals.css" chip per page.
export const COLORS_SOURCE_FILE = "app/globals.css";

// --- Semantic tokens ---------------------------------------------------
// These are what components actually reference. Each maps to a raw token
// via var(...) — the alias field records that chain so the DS can show
// "primary → tree-800" or similar.
export const semanticColorGroups: ColorGroup[] = [
  {
    title: "Surface",
    description: "Backgrounds for the page, cards, popovers and inputs.",
    tokens: [
      { cssVar: "--background", isPublic: true, alias: { light: "--beach-500", dark: "--tree-950" }, description: "Page background." },
      { cssVar: "--card", isPublic: true, alias: { light: "--beach-400", dark: "--tree-950" }, description: "Filter panel, welcome banner, button-card backdrops." },
      { cssVar: "--popover", isPublic: true, alias: { light: "--beach-500", dark: "--tree-950" }, description: "Photo overlay surface." },
      { cssVar: "--muted", isPublic: true, alias: { light: "--palm-400", dark: "--tree-1000" }, description: "Subtle backgrounds — slider track, etc." },
      { cssVar: "--sidebar", isPublic: true, alias: { light: "--beach-500", dark: "--abyss-900" }, description: "Reserved for shadcn sidebar component." },
    ],
  },
  {
    title: "Foreground",
    description: "Text colours intended to sit on the matching surface.",
    tokens: [
      { cssVar: "--foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-100" }, description: "Default body text on --background." },
      { cssVar: "--card-foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-100" }, description: "Text on --card." },
      { cssVar: "--popover-foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-100" }, description: "Text on --popover." },
      { cssVar: "--muted-foreground", isPublic: true, alias: { light: "--tree-900", dark: "--seawater-500" }, description: "De-emphasised text — hints, subtitles." },
    ],
  },
  {
    title: "Brand actions",
    description: "Primary, secondary and accent — the colours that mark interactive intent.",
    tokens: [
      { cssVar: "--primary", isPublic: true, alias: { light: "--tree-800", dark: "--tree-600" }, description: "Primary icons, logo, primary buttons." },
      { cssVar: "--primary-foreground", isPublic: true, alias: { light: "--beach-300", dark: "--abyss-950" }, description: "Text on top of --primary." },
      { cssVar: "--secondary", isPublic: true, alias: { light: "--tree-600", dark: "--tree-800" }, description: "Secondary icon set." },
      { cssVar: "--secondary-foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-100" }, description: "Text on top of --secondary." },
      { cssVar: "--accent", isPublic: true, alias: { light: "--seawater-500", dark: "--seawater-700" }, description: "Highlights — also exposed as bg-grey-green utility." },
      { cssVar: "--accent-foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-200" }, description: "Text on top of --accent." },
    ],
  },
  {
    title: "State",
    description: "Status colours — currently destructive only.",
    tokens: [
      { cssVar: "--destructive", isPublic: true, alias: { light: "--fire-500", dark: "--fire-300" }, description: "Delete / error actions." },
    ],
  },
  {
    title: "Borders & rings",
    description: "Outlines and focus indicators.",
    tokens: [
      { cssVar: "--border", isPublic: true, alias: { light: "--beach-600", dark: "--tree-900" }, description: "Default border colour." },
      { cssVar: "--input", isPublic: true, alias: { light: "--tree-400", dark: "--tree-900" }, description: "Form input borders." },
      { cssVar: "--ring", isPublic: true, alias: { light: "--tree-300", dark: "--seawater-700" }, description: "Focus ring colour." },
    ],
  },
  {
    title: "Sidebar",
    description: "Reserved for the shadcn sidebar component (not currently mounted in this app).",
    tokens: [
      { cssVar: "--sidebar-foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-100" } },
      { cssVar: "--sidebar-primary", isPublic: true, alias: { light: "--tree-800", dark: "--seawater-500" } },
      { cssVar: "--sidebar-primary-foreground", isPublic: true, alias: { light: "--beach-500", dark: "--abyss-950" } },
      { cssVar: "--sidebar-accent", isPublic: true, alias: { light: "--seawater-500", dark: "--abyss-800" } },
      { cssVar: "--sidebar-accent-foreground", isPublic: true, alias: { light: "--abyss-900", dark: "--beach-100" } },
      { cssVar: "--sidebar-border", isPublic: true, alias: { light: "--beach-600", dark: "--abyss-800" } },
      { cssVar: "--sidebar-ring", isPublic: true, alias: { light: "--tree-300", dark: "--seawater-700" } },
    ],
  },
  {
    title: "Charts",
    description:
      "Reserved by shadcn for its chart components (<ChartContainer>, etc.) — five colours so a chart can render up to five distinct data series with consistent tinting. Not currently used in this app because no chart components are installed; kept here so adding charts later doesn't fight the shadcn scaffold. Each step aliases to a green from the tree palette in light mode and a teal/green mix in dark.",
    tokens: [
      { cssVar: "--chart-1", isPublic: true, alias: { light: "--tree-300", dark: "--tree-700" } },
      { cssVar: "--chart-2", isPublic: true, alias: { light: "--tree-400", dark: "--seawater-700" } },
      { cssVar: "--chart-3", isPublic: true, alias: { light: "--tree-500", dark: "--seawater-500" } },
      { cssVar: "--chart-4", isPublic: true, alias: { light: "--tree-600", dark: "--tree-400" } },
      { cssVar: "--chart-5", isPublic: true, alias: { light: "--tree-700", dark: "--seawater-300" } },
    ],
  },
];

// --- Raw palette --------------------------------------------------------
// These are the building blocks. Grouped by hue family so the page reads
// like a paint chart. Order within each family is light → dark.
export const rawColorGroups: ColorGroup[] = [
  {
    title: "Beach",
    description: "Warm off-whites — surfaces, cards, the page background.",
    tokens: [
      { cssVar: "--beach-100", isPublic: true },
      { cssVar: "--beach-200", isPublic: true },
      { cssVar: "--beach-300", isPublic: true },
      { cssVar: "--beach-400", isPublic: true },
      { cssVar: "--beach-500", isPublic: true },
      { cssVar: "--beach-600", isPublic: true },
      { cssVar: "--beach-700", isPublic: true },
      { cssVar: "--beach-800", isPublic: true },
    ],
  },
  {
    title: "Tree",
    description: "Greens — primary brand spectrum.",
    tokens: [
      { cssVar: "--tree-100", isPublic: true },
      { cssVar: "--tree-300", isPublic: true },
      { cssVar: "--tree-400", isPublic: true },
      { cssVar: "--tree-500", isPublic: true },
      { cssVar: "--tree-600", isPublic: true },
      { cssVar: "--tree-700", isPublic: true },
      { cssVar: "--tree-800", isPublic: true },
      { cssVar: "--tree-900", isPublic: true },
      { cssVar: "--tree-950", isPublic: true },
      { cssVar: "--tree-1000", isPublic: true },
    ],
  },
  {
    title: "Seawater",
    description: "Teals — accent and sidebar highlights.",
    tokens: [
      { cssVar: "--seawater-100", isPublic: true },
      { cssVar: "--seawater-300", isPublic: true },
      { cssVar: "--seawater-500", isPublic: true },
      { cssVar: "--seawater-700", isPublic: true },
      { cssVar: "--seawater-900", isPublic: true },
    ],
  },
  {
    title: "Palm",
    description: "Pale yellow-greens — used for muted surfaces.",
    tokens: [
      { cssVar: "--palm-300", isPublic: true },
      { cssVar: "--palm-400", isPublic: true },
      { cssVar: "--palm-500", isPublic: true },
      { cssVar: "--palm-800", isPublic: true },
    ],
  },
  {
    title: "Fire",
    description: "Reds — destructive / error state.",
    tokens: [
      { cssVar: "--fire-300", isPublic: true },
      { cssVar: "--fire-500", isPublic: true },
      { cssVar: "--fire-700", isPublic: true },
    ],
  },
  {
    title: "Abyss",
    description: "Deep blue-greens — body text and dark surfaces.",
    tokens: [
      { cssVar: "--abyss-700", isPublic: true },
      { cssVar: "--abyss-800", isPublic: true },
      { cssVar: "--abyss-900", isPublic: true },
      { cssVar: "--abyss-950", isPublic: true },
    ],
  },
];
