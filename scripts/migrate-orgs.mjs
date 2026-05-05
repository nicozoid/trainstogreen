// One-shot migration: per-variant `source` + optional `relatedSource`
// → flat `orgs[]` array. Already applied to data/walks.json — kept in
// the repo as an audit trail (matches the codebase convention for
// other migrate-*.mjs scripts).
//
// Per-org shape:
//   { orgSlug, type, pageURL?, pageTitle?, walkNumber? }
//
// Mapping rules:
//   - source.orgSlug === "trains-to-green"        → drop entirely (org no longer exists in sources.json)
//   - relatedSource type related/similar/adapted  → rewritten to "main"
//   - tocw1/tocw2 walks                           → walkNumber pulled from entry.tags ("TO1:NN" / "TO2:NN")
//   - field rename                                 → pageName → pageTitle

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const WALKS_PATH = join(ROOT, "data", "walks.json")

const walks = JSON.parse(readFileSync(WALKS_PATH, "utf-8"))

const TYPE_REWRITES = new Set(["related", "similar", "adapted"])

function walkNumberFromTags(orgSlug, tags) {
  if (!Array.isArray(tags)) return ""
  const prefix = orgSlug === "time-out-country-walks-vol-1" ? "TO1:"
                : orgSlug === "time-out-country-walks-vol-2" ? "TO2:"
                : null
  if (!prefix) return ""
  for (const t of tags) {
    if (typeof t !== "string") continue
    if (t.startsWith(prefix)) return t.slice(prefix.length).trim()
  }
  return ""
}

function toOrg(legacy, isRelated, tags) {
  if (!legacy || typeof legacy !== "object") return null
  const orgSlug = typeof legacy.orgSlug === "string" ? legacy.orgSlug.trim() : ""
  if (!orgSlug) return null
  if (orgSlug === "trains-to-green") return null

  const rawType = typeof legacy.type === "string" ? legacy.type.trim() : ""
  const type = isRelated && TYPE_REWRITES.has(rawType) ? "main"
             : (rawType || "main")

  const pageURL = typeof legacy.pageURL === "string" ? legacy.pageURL.trim() : ""
  const pageTitle = typeof legacy.pageName === "string" ? legacy.pageName.trim() : ""
  const walkNumber = walkNumberFromTags(orgSlug, tags)

  const out = { orgSlug, type }
  if (pageURL) out.pageURL = pageURL
  if (pageTitle) out.pageTitle = pageTitle
  if (walkNumber) out.walkNumber = walkNumber
  return out
}

let variantsTouched = 0
let droppedT2G = 0
let walkNumbersAdded = 0
let mainifiedRelated = 0

for (const slug of Object.keys(walks)) {
  const entry = walks[slug]
  if (!Array.isArray(entry.walks)) continue

  for (const variant of entry.walks) {
    const orgs = []
    let touched = false

    if (variant.source) {
      if (variant.source.orgSlug === "trains-to-green") droppedT2G++
      const o = toOrg(variant.source, false, entry.tags)
      if (o) {
        if (o.walkNumber) walkNumbersAdded++
        orgs.push(o)
      }
      delete variant.source
      touched = true
    }

    if (variant.relatedSource) {
      const wasRewrite = TYPE_REWRITES.has(variant.relatedSource.type)
      if (variant.relatedSource.orgSlug === "trains-to-green") droppedT2G++
      const o = toOrg(variant.relatedSource, true, entry.tags)
      if (o) {
        if (wasRewrite) mainifiedRelated++
        if (o.walkNumber) walkNumbersAdded++
        orgs.push(o)
      }
      delete variant.relatedSource
      touched = true
    }

    if (touched) {
      if (orgs.length > 0) variant.orgs = orgs
      variantsTouched++
    }
  }
}

writeFileSync(WALKS_PATH, JSON.stringify(walks, null, 2) + "\n")

console.log(`Migrated ${variantsTouched} variants.`)
console.log(`  - dropped trains-to-green from ${droppedT2G} orgs entries`)
console.log(`  - added walkNumber to ${walkNumbersAdded} TOCW orgs entries`)
console.log(`  - rewrote ${mainifiedRelated} related/similar/adapted → main`)
