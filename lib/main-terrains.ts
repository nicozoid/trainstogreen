// Canonical "main terrain" vocabulary used by the walk editor's
// Main Terrains toggle row. Stored on each walk as a string[] of
// these values (any subset, including empty).
//
// Distinct from the free-text `terrain` field: this set is closed and
// machine-friendly, suitable for filtering / facets / structured prose.
// `terrain` stays as the free-text catch-all for nuance ("rolling
// chalk downs", "Roman road remnants" — things that don't fit a tag).

export type MainTerrainValue =
  | "mountains"
  | "hills"
  | "coastal"
  | "waterways"
  | "woodland"
  | "historic_urban"

// Display order = button order in the editor row. Loosely sorted
// by altitude / scale: mountains > hills > coastal > waterways >
// woodland > historic_urban. Reorder here if a different ordering
// reads better.
export const MAIN_TERRAINS: { value: MainTerrainValue; label: string }[] = [
  { value: "mountains",      label: "Mountains" },
  { value: "hills",          label: "Hills" },
  { value: "coastal",        label: "Coastal" },
  { value: "waterways",      label: "Waterways" },
  { value: "woodland",       label: "Woodland" },
  { value: "historic_urban", label: "Historic urban" },
]

// Set of valid values — used by the server cleaner to drop unknown
// strings on save (mirrors VALID_SPOT_TYPES in lib/spot-types.ts).
export const VALID_MAIN_TERRAINS = new Set<string>(MAIN_TERRAINS.map((t) => t.value))
