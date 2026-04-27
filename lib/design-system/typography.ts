/**
 * Typography registry for the DS app.
 *
 * Unlike colours and other tokens, typography in this app is NOT
 * tokenised — there are no --type-h1-size variables. Every piece of
 * text uses Tailwind utility class strings directly. So this file
 * is a manually-curated catalogue of the recurring named styles.
 *
 * Each entry is a "specimen": a class string that gets applied to a
 * sample of text. The DS card live-resolves the computed font
 * metrics (size, weight, tracking, leading) at render time so the
 * displayed numbers match whatever Tailwind currently produces from
 * the class string. Edit the class → metadata updates with no
 * registry change.
 */

// One entry per named type style.
export type TypeSpecimen = {
  id: string;             // stable identifier, used as React key + URL hash
  name: string;           // display name shown above the metadata
  classes: string;        // Tailwind class string (typography subset only)
  description: string;    // what it's used for in the app
  // 2-3 representative file paths where this style appears. Not
  // exhaustive — just enough for the user to jump in.
  examples: string[];
  sample: string;         // text from "The Dry Salvages" section 3
  // isPublic === false hides the specimen from the DS view. Currently
  // every specimen below is public; admin/dev-only typography (mono
  // map readouts etc) was deliberately excluded from the registry.
  isPublic: boolean;
};

// Categories shown as separate <h2> sections on the page.
export type TypeGroup = {
  title: string;
  description?: string;
  specimens: TypeSpecimen[];
};

// --- Fonts -------------------------------------------------------------
// The two font FAMILIES loaded for this app. These specimens are
// rendered with a slightly different card (FontSpecimen) so we can
// show the variable-weight ladder for the sans family.
export type FontSpecimen = {
  id: string;
  name: string;            // "General Sans Variable"
  cssVar: string;          // "--font-sans"
  classes: string;         // class to set the family, e.g. "font-sans"
  description: string;
  // For variable fonts: the weight axis to render side-by-side. For
  // static fonts: undefined (single rendering).
  weights?: number[];
  // Where the family is loaded.
  loadedIn: string;
  sample: string;
  isPublic: boolean;
};

export const fonts: FontSpecimen[] = [
  {
    id: "font-sans",
    name: "General Sans Variable",
    cssVar: "--font-sans",
    classes: "font-sans",
    description:
      "The default UI font. Variable axis 200–700, so any font-light through font-bold pulls a different weight from the same file. Loaded as a self-hosted woff2 in app/layout.tsx.",
    weights: [200, 300, 400, 500, 600, 700],
    loadedIn: "app/layout.tsx",
    sample:
      "I sometimes wonder if that is what Krishna meant— Among other things—or one way of putting the same thing: That the future is a faded song, a Royal Rose or a lavender spray of wistful regret for those who are not yet here to regret, pressed between yellow leaves of a book that has never been opened.",
    isPublic: true,
  },
  {
    id: "font-mono",
    name: "Geist Mono",
    cssVar: "--font-mono",
    classes: "font-mono",
    description:
      "Monospaced face used wherever character alignment matters — code snippets, station codes, the occasional metadata chip. Loaded via next/font from Google Fonts.",
    loadedIn: "app/layout.tsx",
    sample:
      "And the way up is the way down, the way forward is the way back. You cannot face it steadily, but this thing is sure, that time is no healer: the patient is no longer here.",
    isPublic: true,
  },
];

// --- Type styles -------------------------------------------------------
// Twelve named styles, organised by visual role. The order here is
// the order they render on the page.
export const typeGroups: TypeGroup[] = [
  {
    title: "Display & headings",
    description: "Anything that names a region of the UI.",
    specimens: [
      {
        id: "heading-modal-title",
        name: "Heading / modal title",
        classes: "text-lg font-semibold",
        description: "The largest text in the public app. Modal titles and the welcome-banner top heading.",
        examples: ["components/welcome-banner.tsx", "components/photo-overlay.tsx"],
        sample: "When the train starts, and the passengers are settled",
        isPublic: true,
      },
      {
        id: "heading-subsection",
        name: "Subsection heading",
        classes: "text-sm font-semibold",
        description: "Section titles inside the photo-overlay (e.g. \"Alternative routes\", \"Notes\").",
        examples: ["components/photo-overlay.tsx", "components/admin-edits-dialog.tsx"],
        sample: "To fruit, periodicals and business letters",
        isPublic: true,
      },
      {
        id: "heading-filter-group",
        name: "Filter group label",
        classes: "text-sm font-medium",
        description: "Labels above grouped controls in the filter panel.",
        examples: ["components/filter-panel.tsx"],
        sample: "And those who saw them off have left the platform",
        isPublic: true,
      },
    ],
  },
  {
    title: "Body",
    description: "Paragraph copy.",
    specimens: [
      {
        id: "body-relaxed",
        name: "Body relaxed",
        classes: "text-sm leading-relaxed",
        description: "Intro paragraphs — extra leading for readability when the user is reading prose, not scanning UI.",
        examples: ["components/welcome-banner.tsx"],
        sample:
          "Their faces relax from grief into relief, to the sleepy rhythm of a hundred hours. Fare forward, travellers! not escaping from the past into different lives, or into any future; you are not the same people who left that station or who will arrive at any terminus.",
        isPublic: true,
      },
      {
        id: "body",
        name: "Body",
        classes: "text-sm",
        description: "Default paragraph copy in modals — same size as the relaxed variant but tighter line-height for denser content.",
        examples: ["components/photo-overlay.tsx"],
        sample:
          "While the narrowing rails slide together behind you; and on the deck of the drumming liner watching the furrow that widens behind you, you shall not think 'the past is finished' or 'the future is before us'.",
        isPublic: true,
      },
    ],
  },
  {
    title: "Secondary text",
    description: "Muted helper copy that supports primary content rather than carrying it.",
    specimens: [
      {
        id: "hint-description",
        name: "Hint / description",
        classes: "text-sm text-muted-foreground",
        description: "Explanatory text that sits under headings, supplementing the main copy.",
        examples: ["components/photo-overlay.tsx"],
        sample: "At nightfall, in the rigging and the aerial, is a voice descanting",
        isPublic: true,
      },
      {
        id: "caption",
        name: "Caption",
        classes: "text-xs text-muted-foreground",
        description: "Smallest helper text — option labels under filters, inline hints under controls.",
        examples: ["components/filter-panel.tsx"],
        sample: "Though not to the ear, the murmuring shell of time",
        isPublic: true,
      },
    ],
  },
  {
    title: "UI labels",
    description: "Text that names interactive controls.",
    specimens: [
      {
        id: "button-label",
        name: "Button label",
        classes: "text-sm font-semibold",
        description: "Built into the Button component's CVA — every variant inherits this. Don't add explicit text-* classes to a <Button> child unless overriding deliberately.",
        examples: ["components/ui/button.tsx"],
        sample: "Fare forward",
        isPublic: true,
      },
      {
        id: "form-label",
        name: "Form label",
        classes: "text-sm leading-none font-medium",
        description: "Built into the Label component. Tighter leading because labels are usually one line above an input.",
        examples: ["components/ui/label.tsx"],
        sample: "O voyagers, O seamen",
        isPublic: true,
      },
    ],
  },
  {
    title: "Metadata",
    description: "Small inline labels that name a value.",
    specimens: [
      {
        id: "field-marker",
        name: "Field marker",
        classes: "text-xs font-medium text-muted-foreground",
        description: "Small prefix labels that sit beside inline values in modals. The metadata equivalent of a form label.",
        examples: ["components/photo-overlay.tsx"],
        sample: "Not fare well",
        isPublic: true,
      },
    ],
  },
];
