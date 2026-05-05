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
  | "church"
  | "museum"
  | "historic_site"
  | "monument"
  // Settlement
  | "village"
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
  { value: "church", label: "Church / chapel", group: "Cultural" },
  { value: "museum", label: "Museum / gallery", group: "Cultural" },
  { value: "historic_site", label: "Historic site", group: "Cultural" },
  { value: "monument", label: "Monument", group: "Cultural" },
  { value: "village", label: "Village / hamlet", group: "Settlement" },
  { value: "farm_shop", label: "Farm shop", group: "Other" },
]

// Set of valid values, used by the server cleaner to drop unknown
// strings on save.
export const VALID_SPOT_TYPES = new Set<string>(SPOT_TYPES.map((t) => t.value))

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
