// Canonical type vocabulary for Sights / Lunch stops / Destination
// stops on each walk. A spot can carry zero or more of these tags;
// the editor renders them as a multi-select dropdown.
//
// Both Pull-data buttons (Komoot, Places) read upstream classification
// data and map it into this same vocabulary, so highlights from
// Komoot and POIs from Google Places agree on what "pub" or "church"
// means.

export type SpotTypeValue =
  // Refreshments
  | "pub"
  | "restaurant"
  | "cafe"
  | "tearoom"
  // Natural features
  | "viewpoint"
  | "forest"
  | "river_lake"
  | "coast"
  | "summit"
  | "waterfall"
  // Outdoor / public
  | "park"
  | "garden"
  | "nature_reserve"
  // Cultural / built
  | "castle"
  | "stately_home"
  | "church"
  | "museum"
  | "historic_site"
  | "historic_street"
  | "monument"
  // Settlement
  | "village"
  | "historic_town"
  | "historic_city"
  // Other
  | "farm_shop"

// Display order for the dropdown — refreshment tags up top so admins
// see the most-used ones first when curating walks. Within each group
// the ordering loosely follows "expected hit frequency" rather than
// alphabetical.
export const SPOT_TYPES: { value: SpotTypeValue; label: string; group: string }[] = [
  { value: "pub", label: "Pub", group: "Refreshments" },
  { value: "restaurant", label: "Restaurant", group: "Refreshments" },
  { value: "cafe", label: "Café", group: "Refreshments" },
  { value: "tearoom", label: "Tearoom", group: "Refreshments" },
  { value: "viewpoint", label: "Viewpoint", group: "Natural" },
  { value: "forest", label: "Forest / wood", group: "Natural" },
  { value: "river_lake", label: "River / lake", group: "Natural" },
  { value: "coast", label: "Coast / beach", group: "Natural" },
  { value: "summit", label: "Summit / hill", group: "Natural" },
  { value: "waterfall", label: "Waterfall", group: "Natural" },
  { value: "park", label: "Park", group: "Outdoor" },
  { value: "garden", label: "Garden", group: "Outdoor" },
  { value: "nature_reserve", label: "Nature reserve", group: "Outdoor" },
  { value: "castle", label: "Castle / fort", group: "Cultural" },
  { value: "stately_home", label: "Stately home", group: "Cultural" },
  { value: "church", label: "Church / chapel", group: "Cultural" },
  { value: "museum", label: "Museum / gallery", group: "Cultural" },
  { value: "historic_site", label: "Historic site", group: "Cultural" },
  { value: "historic_street", label: "Historic street", group: "Cultural" },
  { value: "monument", label: "Monument", group: "Cultural" },
  { value: "village", label: "Village / hamlet", group: "Settlement" },
  { value: "historic_town", label: "Historic town", group: "Settlement" },
  { value: "historic_city", label: "Historic city", group: "Settlement" },
  { value: "farm_shop", label: "Farm shop", group: "Other" },
]

// Set of valid values, used by the server cleaner to drop unknown
// strings on save.
export const VALID_SPOT_TYPES = new Set<string>(SPOT_TYPES.map((t) => t.value))

// Refreshment-style types — a venue tagged with any of these belongs
// in the Lunch stops or Destination pubs section, never Sights. The
// walk editor watches this set when types change on a row and moves
// the row between sections automatically.
export const REFRESHMENT_SPOT_TYPES = new Set<SpotTypeValue>([
  "pub", "restaurant", "cafe", "tearoom",
])

// Sight types that get their `location` field auto-populated by Pull
// URLs (Google Places). Other sight types are left blank unless an
// admin types a location in by hand.
//
// Inclusion rule: the type names a discrete venue inside a recognisable
// town/suburb where prefixing "in {loc}" actually adds info — castles,
// churches, museums, historic sites, monuments, plus historic streets
// (which always sit inside a named town).
//
// Notable exclusions:
//   - stately_home — typically sits out of any settlement, so a town
//     label rarely fits.
//   - village / historic_town / historic_city (Settlement group) — the
//     venue IS the location; "in {sub-locality}" reads redundantly.
//   - viewpoints / forests / coast / etc. — too vague for a town label
//     to add useful framing.
export const LOCATIONABLE_SPOT_TYPES = new Set<SpotTypeValue>([
  "castle", "church", "museum", "historic_site", "historic_street", "monument",
])

// Threshold for "near the end of the walk", expressed as a fraction
// of the total route. A refreshment venue whose route-distance from
// the end is within this fraction of totalKm buckets as a destination
// stop; venues farther back are lunch stops. Relative-rather-than-
// absolute (the previous rule was a flat 4 km cutoff) so the split
// scales with walk length: a 20 km walk's "near the end" zone is
// 4 km, but a 5 km walk's is only 1 km — matching how the admin
// thinks about "the pub at the end" on short vs long routes.
export const DESTINATION_STOP_FRACTION = 0.3

// Pick the right refreshment section for a venue at `kmIntoRoute` on a
// walk of `totalKm`. Either input may be undefined / not-a-number — in
// which case we fall back to "lunch", on the basis that an unknown
// distance is more likely mid-walk than end-of-walk.
export function bucketForRefreshment(
  kmIntoRoute: number | undefined,
  totalKm: number | undefined,
): "destination" | "lunch" {
  if (typeof totalKm !== "number" || !Number.isFinite(totalKm) || totalKm <= 0) return "lunch"
  const km = typeof kmIntoRoute === "number" && Number.isFinite(kmIntoRoute) ? kmIntoRoute : 0
  const fractionFromEnd = Math.max(0, (totalKm - km) / totalKm)
  return fractionFromEnd <= DESTINATION_STOP_FRACTION ? "destination" : "lunch"
}

// Lookup: canonical value → human label, for the admin chip display.
export const SPOT_TYPE_LABELS: Record<string, string> = SPOT_TYPES.reduce(
  (acc, t) => {
    acc[t.value] = t.label
    return acc
  },
  {} as Record<string, string>,
)

// ── Komoot → canonical types ────────────────────────────────────────
//
// Komoot tags each highlight with a `categories` string array
// (vocabulary like "pub", "viewpoint", "religious_building"). POIs
// instead carry a numeric `category` we decode separately upstream
// — by the time we hit this map, both shapes have been normalised
// into a flat string array.
//
// Tags not present here are silently ignored — many Komoot tags
// ("intermediate", "trail", "wheelchair_accessible", …) are
// non-classification metadata.
//
// Notable omission: `man_made_monument`. Komoot applies this tag
// indiscriminately to country houses, churches, ruins, statues, and
// anything else that's "built". Mapping it to `monument` produces
// false positives (e.g. St Albans Cathedral classed as a monument
// alongside its proper `church` tag, or Childwickbury Estate classed
// as a monument when it's a settlement). Real monuments still get
// `historic_site` (which they're invariably also tagged with), and
// admins can manually toggle `monument` when the venue actually is
// one (war memorial, statue, etc.).
export const KOMOOT_TO_SPOT_TYPES: Record<string, SpotTypeValue> = {
  pub: "pub",
  restaurant: "restaurant",
  cafe: "cafe",
  viewpoint: "viewpoint",
  forest: "forest",
  lakes_rivers: "river_lake",
  coastline: "coast",
  mountain_summits: "summit",
  waterfall: "waterfall",
  waterfalls: "waterfall",
  parks: "park",
  religious_building: "church",
  historical_site: "historic_site",
  cultural_historical: "historic_site",
  settlement: "village",
}

// Komoot stamps `viewpoint` on practically any highlight that has a
// view — including specific nature features that aren't viewpoints
// per se (a forest with a clearing, a lakeside spot, a hilltop). When
// one of these more specific feature tags is also present, the
// venue's primary character is the specific feature; drop viewpoint
// from the mapped output. Keeps "View of Woburn Safari Park" (no
// other nature tag) correctly classified as a viewpoint while
// preventing "Heartwood Forest" from being one too.
export const VIEWPOINT_SUPERSEDED_BY = new Set([
  "forest",
  "lakes_rivers",
  "coastline",
  "mountain_summits",
  "waterfall",
  "waterfalls",
])

// ── Google Places → canonical types ─────────────────────────────────
//
// Places' `types` field is an array of strings drawn from a much
// bigger vocabulary than Komoot's. We only map the values useful to
// hike planning; anything else is dropped. Some Google types collapse
// into a single canonical (e.g. `bar` and `pub` both → "pub").
export const GOOGLE_TO_SPOT_TYPES: Record<string, SpotTypeValue> = {
  bar: "pub",
  pub: "pub",
  restaurant: "restaurant",
  cafe: "cafe",
  bakery: "cafe",
  museum: "museum",
  art_gallery: "museum",
  church: "church",
  place_of_worship: "church",
  park: "park",
  garden: "garden",
  campground: "nature_reserve",
  natural_feature: "viewpoint",
  // tourist_attraction is intentionally omitted — too generic.
}
