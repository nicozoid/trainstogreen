// Extract proper-noun phrases from free-text notes — used to seed the
// Flickr custom-tag list when an admin switches a station to "custom" algo.
//
// Two-pass design:
//   1. Regex to capture capitalised word-sequences (same as before).
//   2. Classify each phrase into a category based on suffix / keyword hints.
//
// Categories drive the tag-seeding ORDER (which matters for the Flickr 20-tag
// cap — earlier categories survive truncation):
//   trails      — "Ridgeway", "North Downs Way", "Bruton Circular"
//   terrains    — "Greensand Ridge", "Chiltern Hills", "Somerset Levels"
//   sights      — "Alfred's Tower", "Stourhead House", "Cadbury Castle"
//   settlements — everything else left over ("Bruton", "Batcombe")
//
// Lunch-venue-looking phrases ("Three Horseshoes Inn", "Prickly Pear") are
// dropped entirely — they're seldom photographed meaningfully on Flickr.
//
// This is a heuristic pass — not perfect. The admin edits the seed afterwards.

const LEADING_STOP_WORDS = new Set(["the", "a", "an"])

const NOISE_SINGLETONS = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "london",
  "i", // the pronoun "I" at the start of a sentence
  // Common sentence-opener words that aren't proper nouns. The
  // isSentenceInitial() filter catches most of these already; this list
  // is a belt-and-braces for ones that appear mid-sentence too (e.g.
  // "Walks" as a section heading in Markdown).
  "walks", "nonstop", "adapted", "also", "nearby", "this",
])

// Suffix markers — the LAST word in a phrase is often the category signal.
// E.g. "... Way" → trail, "... Hill" → terrain, "... Castle" → sight.
const TRAIL_LAST_WORDS = new Set([
  "way", "path", "trail", "walk", "circular", "ridgeway",
])
const TERRAIN_LAST_WORDS = new Set([
  "hill", "hills", "downs", "down", "ridge", "beacon", "tor", "valley",
  "moor", "moors", "heath", "heaths", "fell", "fells", "wood", "woods",
  "forest", "levels", "edge", "plateau", "mountain", "cliff", "cliffs",
  "marsh", "marshes", "bay", "coast", "brook", "river", "meadow", "meadows",
  "common", "commons", "estuary",
])
const SIGHT_WORDS = new Set([
  "castle", "tower", "abbey", "church", "cathedral", "minster",
  "bridge", "pantheon", "temple", "monument", "lighthouse",
  "mill", "windmill", "garden", "gardens", "manor", "palace",
  "estate", "dovecote", "obelisk", "folly", "ruins", "fort",
  "circle", "stones", "stone", "pier", "barrow", "henge",
])

// Lunch-venue markers — if a phrase contains any of these, skip it entirely.
// Pub/inn names in the UK follow predictable patterns: "<Adjective> <Animal>",
// "<Colour> <Something> Inn", etc. We also block common cafe/restaurant words.
const LUNCH_MARKERS = new Set([
  "inn", "pub", "tavern", "arms", "kitchen", "restaurant",
  "café", "cafe", "coffee", "rooms", "bistro", "brewery",
])

// Organization / publication / product markers — phrases containing any of
// these are almost always orgs, books, or magazines rather than places.
// "Century National Trust", "Rough Guide", "South East Rambler" all get
// caught here. Kept generous since the admin edits the seed anyway.
const ORG_MARKERS = new Set([
  "trust", "guide", "rambler", "ramblers", "society", "club",
  "association", "magazine", "foundation", "publications", "publication",
  "group", "limited", "ltd", "plc",
])

// Single-word known pub names without a marker word (e.g. "The Briar").
// Not exhaustive — the Inn/Arms suffix catches most, this is a small bailout.
const SINGLE_WORD_LUNCH_NAMES = new Set(["briar"])

export type PlaceNameCategory = "trail" | "terrain" | "sight" | "settlement"

export type ClassifiedPlaceNames = {
  trails: string[]
  terrains: string[]
  sights: string[]
  settlements: string[]
  // lunch venues are dropped entirely — no list returned.
}

function classify(phrase: string): PlaceNameCategory | "drop" {
  const words = phrase.split(" ")
  const lastWord = words[words.length - 1]
  // Drop lunch venues first — blocks anything containing a lunch marker.
  if (words.some((w) => LUNCH_MARKERS.has(w))) return "drop"
  if (words.length === 1 && SINGLE_WORD_LUNCH_NAMES.has(phrase)) return "drop"
  // Drop organization / product / publication names. "Century National Trust",
  // "Rough Guide", "South East Rambler" all get caught here.
  if (words.some((w) => ORG_MARKERS.has(w))) return "drop"
  // Trails: suffix like "Way" or "Circular", or the special single "Ridgeway".
  if (TRAIL_LAST_WORDS.has(lastWord)) return "trail"
  // Terrains: suffix like "Hill", "Downs", "Levels".
  if (TERRAIN_LAST_WORDS.has(lastWord)) return "terrain"
  // Sights: any word in the phrase is a landmark-type marker.
  if (words.some((w) => SIGHT_WORDS.has(w))) return "sight"
  // Fallback: settlement (village/town/hamlet).
  return "settlement"
}

// Returns true when the regex match at `idx` is the first word of a sentence —
// i.e. preceded only by whitespace back to a sentence terminator (".", "!",
// "?", newline) or the start of the text. Used to drop single-word matches
// that are capitalised only because they start a sentence ("Nonstop ...",
// "Adapted ...", "Walks from ..."), not because they're proper nouns.
function isSentenceInitial(text: string, idx: number): boolean {
  let i = idx - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i < 0) return true
  const prev = text[i]
  return prev === "." || prev === "!" || prev === "?" || prev === "\n" ||
    prev === '"' || prev === "\u201C" || prev === "\u201D"
}

/**
 * Extracts place-name-ish phrases from free text and classifies them.
 * Returns lowercase, deduped buckets. Lunch venues, organization/product
 * names, and sentence-initial single-word captures are silently dropped.
 */
export function categorizePlaceNames(...texts: string[]): ClassifiedPlaceNames {
  const combined = texts.filter(Boolean).join(" ")
  const empty: ClassifiedPlaceNames = { trails: [], terrains: [], sights: [], settlements: [] }
  if (!combined) return empty

  const pattern = /\b(?:\p{Lu}\p{Ll}*(?:['']?\p{Ll}+)?)(?:\s+\p{Lu}\p{Ll}*(?:['']?\p{Ll}+)?)*\b/gu

  const seen = new Set<string>()
  const out: ClassifiedPlaceNames = { trails: [], terrains: [], sights: [], settlements: [] }

  // Iterate with positions so we can do sentence-initial filtering on
  // single-word matches (the common false-positive case).
  let m: RegExpExecArray | null
  while ((m = pattern.exec(combined)) !== null) {
    const rawIdx = m.index
    const words = m[0].split(/\s+/)
    // Strip leading articles ("The Ridgeway" → "Ridgeway")
    while (words.length && LEADING_STOP_WORDS.has(words[0].toLowerCase())) {
      words.shift()
    }
    if (words.length === 0) continue
    const phrase = words.join(" ").toLowerCase()
    // Drop too-short fragments (single letters, abbreviations)
    if (phrase.length < 3) continue
    // Drop known noise singletons (months, days, pronouns, common sentence-
    // starter words that happen to get capitalised).
    if (words.length === 1 && NOISE_SINGLETONS.has(phrase)) continue
    // Drop single-word matches that are capitalised only because they start
    // a sentence. Multi-word matches are exempted — a multi-word capitalised
    // sequence is strong signal even at sentence start ("Castle Cary is...").
    if (words.length === 1 && isSentenceInitial(combined, rawIdx)) continue
    if (seen.has(phrase)) continue
    seen.add(phrase)

    const cat = classify(phrase)
    if (cat === "drop") continue
    out[cat === "trail" ? "trails" : cat === "terrain" ? "terrains" : cat === "sight" ? "sights" : "settlements"].push(phrase)
  }

  return out
}

/**
 * Legacy flat extraction — kept for callers that don't need categories.
 * Returns all place names in the order: trails, terrains, sights, settlements.
 */
export function extractPlaceNames(...texts: string[]): string[] {
  const { trails, terrains, sights, settlements } = categorizePlaceNames(...texts)
  return [...trails, ...terrains, ...sights, ...settlements]
}
