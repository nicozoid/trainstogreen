# Design system — working principles

This file is loaded automatically when working anywhere under
`app/design-system/` or `components/design-system/`. Read it before
making changes to the design system. Add to it as new conventions are
established (and explain *why*, not just *what*).

## What the DS app is

A live, in-app reference for every visual primitive, component, and
piece of motion used in the public Trains to Green app. It's a
mini-app inside the main app — a separate route tree
(`/design-system`), separate component folder
(`components/design-system/`), separate registries
(`lib/design-system/`). The isolation is deliberate so the DS scaffold
can be lifted into another product with minimal rework.

The DS is also the surface that catches consistency drift. The
**Anomalies** page is where divergences between similar things get
recorded with stable copyable codes — codes are how the user
references "let's fix r3xl" in conversation.

## Hard rules

### 1. The `isPublic` rule

Every catalogued thing — components, tokens, type styles — has an
`isPublic` flag. **Admin-only / dev-only UI is hidden from the DS.**

If a component is only mounted inside `{adminMode && ...}` or
`NODE_ENV === "development"` blocks, it must be `isPublic: false`. The
DS still keeps the entry (so codes / cross-references stay stable)
but the component doesn't render in the public view.

When examples or demos are wired up, **never use admin-only file
paths or admin-only labels as examples**. The Atoms/Input demo
once used "Search stations" — that's only visible in admin mode.
The correct example is "Other London stations" / "Other stations"
from the public friend/primary station picker.

### 2. The DS app must remain isolated

- Files under `components/design-system/` MUST NOT be imported from
  outside `app/design-system/`. The DS imports *from* the main app
  (it's a viewer); the reverse is forbidden.
- New DS pages add files under `app/design-system/` and
  `lib/design-system/` only. Don't put DS-specific helpers in
  shared utility folders.

### 3. Voice and copy

- **No first-person or second-person pronouns** in DS user-visible
  copy. No "I", "me", "you", "we". Code comments are fine — those
  are for developers reading source.
- **Sample text in Typography uses Eliot's "The Dry Salvages"
  section 3.** Eliot wrote "you" — that's source material, leave it.
- Copy should not reveal the implementation context (don't write
  "ask me to fix" — write "click the code to copy it").

### 4. Live-resolved values, not hardcoded

Token values come from `getComputedStyle` at render time. Never
duplicate hex / oklch / rem values into the registry. Editing
`globals.css` should automatically update the DS.

The registry holds **metadata only** — names, descriptions, isPublic,
file paths, alias chains, usage lists. Values are read live.

## Conceptual frameworks

### The four-tier component hierarchy (biological metaphor)

The DS sorts components into four tiers, each one rung up the
biology ladder:

| Tier | Examples | Test |
|---|---|---|
| **Atoms** | Button, Checkbox, Input | Would this look identical in any other product? |
| **Molecules** | (none currently public) | Could this file be copied into a different project as-is, given different data? |
| **Macromolecules** | FilterPanel, WelcomeBanner | Would the *shape* make sense in a totally different product? |
| **Organelles** | PhotoOverlay | Does it read more like a "view" or "modal" than a "component"? |

Definitions live in `lib/design-system/components.ts → tierInfo`. Don't
edit those casually — they've been refined over multiple sessions.

The sidebar separately groups visual primitives under a **PARTICLES**
section header (Colour, Layout tokens, Typography, Motion, Logo,
Iconography). "Particles" was chosen so "Atoms" could be the smallest
*component* tier without name collision.

### Anomalies

Things that *might* be bugs but might also be intentional. Each entry
has:
- A stable 4-character base36 code (never reused — even if the entry
  becomes `status: "fixed"`, keep it in the registry)
- A category, a status pill, optional `flaggedBy: "human"` for things
  noticed by the designer rather than automated surveys
- Locations + a suggested fix

Codes are how the user references one in conversation
("let's resolve r3xl"). Never renumber or recycle codes.

### Motion phases

Animations with distinct entry/exit (or draw/erase, open/close) use
a `phases` array in the registry, rendered as separate sub-sections
on the Motion card with HR + uppercase sub-header. **Don't mash
entry and exit values into one string** — that was an early mistake.

## Patterns when extending the DS

### Adding a new primitive page (under PARTICLES)

1. Add a registry file in `lib/design-system/<thing>.ts` — metadata
   only, plus type definitions.
2. Add visualisation components under
   `components/design-system/<thing>-card.tsx` — these read live values
   via `useCssVar` or similar.
3. Add the route page at `app/design-system/<thing>/page.tsx`.
4. Add the entry to `PARTICLES` in `ds-shell.tsx`.
5. Add a tile to `app/design-system/page.tsx`.

### Adding a new component to a tier

1. Add a `ComponentEntry` to the appropriate array in
   `lib/design-system/components.ts`.
2. Add a demo function to the matching `*-demos.tsx` file (atoms →
   `atom-demos.tsx`, etc.).
3. Add a `case` to that tier page's `pickDemo` switch.
4. Verify in the browser. Anchor link in sidebar generates
   automatically.

### Renaming a tier or section

Order matters when names collide (e.g. "Molecules" can refer to two
different tiers across renames). Always:

1. Move/rename the *displaced* identifier first (out of the way).
2. Move the *replacement* identifier in.
3. Update registry types, exported names, imports, route paths,
   sidebar navigation, page headers, tile descriptions, comments.
4. Run typecheck. Stale errors in the dev log are common — verify in
   browser too.

### When something looks broken in the DS

First check whether it's a real DS bug or a real **app** issue the DS
is correctly surfacing. The DS often catches things like undefined
CSS variables, unused tokens, mismatched aspect ratios. If it's an
app issue, the right move is usually an Anomaly entry, not "fixing"
the DS to hide it.

## What NOT to do

- Don't try to centralise things just because they look similar. Voice
  matters: "Atoms vs Molecules" had real semantic content; merging them
  would lose that.
- Don't auto-lint / auto-fix in the DS. Surface findings as Anomalies
  with stable codes; let the user decide.
- Don't add hex literals to demos. If a colour belongs in the DS, it
  goes in `globals.css` first, then the registry references the
  variable name.
- Don't leave examples pointing at admin-only file paths. Re-grep
  for public usages.
