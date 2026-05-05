// Canonical "place" registry shared across walks. Phase 1 of the
// places-registry refactor:
//   - data/places.json holds one entry per venue (sight, pub, cafe,
//     settlement, viewpoint…) keyed by a stable slug id
//   - data/walks.json's per-walk sights/lunchStops/destinationStops
//     arrays now hold thin stubs ({ placeId, kmIntoRoute }) that
//     dereference into the registry
//   - the renderer + the walks-for-station endpoint hydrate stubs
//     into full venue objects before formatting / shipping to the
//     editor, so consumers above this layer see the same flat shape
//     they always saw
//
// Phase 1 deliberately keeps the editor UI unchanged. Autocomplete,
// sync indicators, and Pull-data registry matching land in later
// phases. Single point of edit truth ships first, UX builds on top.

export type Place = {
  /** Display name. Required. Mirrors the only-required-field
   *  validation the per-row cleaners use. */
  name: string
  /** Sub-locality the place sits in, e.g. "St Albans". Drives the
   *  grouped public prose ("Sights in St Albans: …"). Empty when
   *  the place IS a settlement (in which case the place's name is
   *  itself the location). */
  location?: string
  /** Canonical homepage URL. Empty when no useful link is known. */
  url?: string
  /** Decimal lat/lng. null/undefined for settlement-style places
   *  that don't pin to a single point on the map. */
  lat?: number | null
  lng?: number | null
  /** Spot-type tags drawn from lib/spot-types (multi-select). */
  types?: string[]
  /** Google Places business status (OPERATIONAL /
   *  CLOSED_TEMPORARILY / CLOSED_PERMANENTLY) or empty when unknown.
   *  Drives the public-prose isLive() filter. */
  businessStatus?: string
  /** Refreshment-row data — only meaningful for pub/cafe/restaurant/
   *  tearoom places; ignored elsewhere. */
  rating?: "" | "good" | "fine" | "poor"
  busy?: "" | "busy" | "quiet"
  /** Admin-only freeform commentary. Used as `notes` on refreshment
   *  rows (renders in parens after the venue name) and as
   *  `description` on sights (also renders in parens). The same
   *  string field plays both roles depending on row context — the
   *  editor maps `description` ↔ `notes` based on which list the
   *  row sits in. Migrated as `description` for sights, `notes`
   *  for refreshments; the registry stores under whichever was set
   *  on the source row. */
  description?: string
  notes?: string
}

export type PlaceRegistry = Record<string, Place>

/** Walk-level reference to a registry entry. The walk array holds
 *  these stubs; resolution into a full venue happens at the
 *  consumer boundary (renderer / walks-for-station hydration). */
export type WalkPlaceRef = {
  placeId: string
  /** Approx. km along the route at this venue's index. Per-walk —
   *  the same place can appear at different kmIntoRoute on
   *  different walks. */
  kmIntoRoute?: number | null
}

/** Stable slug generation for place ids. Lowercase, alphanumeric,
 *  with hyphens between word boundaries. Discriminator (location
 *  or first type) appended so two places with the same name but
 *  different locations get distinct slugs. Caller resolves
 *  collisions by appending -2, -3, etc. */
export function buildPlaceSlug(p: { name: string; location?: string; types?: string[] }): string {
  const base = slugify(p.name)
  const loc = slugify(p.location ?? "")
  if (loc && loc !== base) return `${base}-${loc}`
  const tag = (p.types ?? [])[0]
  if (tag) return `${base}-${slugify(tag)}`
  return base
}

export function slugify(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")               // non-alphanum → hyphen
    .replace(/^-+|-+$/g, "")                   // trim leading/trailing
}

/** Reserve a unique slug in the registry. If `base` is taken, walks
 *  -2, -3, … until a free one is found. Pure: doesn't mutate the
 *  registry, just returns the chosen id. */
export function reserveSlug(base: string, registry: PlaceRegistry): string {
  if (!(base in registry)) return base
  let n = 2
  while (`${base}-${n}` in registry) n++
  return `${base}-${n}`
}

/** Hydrate a walk-stub row into a full venue object the editor +
 *  renderer can consume. Returns null when the placeId can't be
 *  found — caller decides whether to drop the row or warn. */
export function hydrateRow(
  stub: WalkPlaceRef,
  registry: PlaceRegistry,
): (Place & WalkPlaceRef) | null {
  const place = registry[stub.placeId]
  if (!place) return null
  return { ...place, placeId: stub.placeId, kmIntoRoute: stub.kmIntoRoute ?? null }
}
