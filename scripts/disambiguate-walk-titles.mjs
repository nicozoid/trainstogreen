// Walks with identical derived titles ("Tring to Berkhamsted" × 3,
// "Eynsford Circular" × 2, etc.) are hard to tell apart in the
// rendered prose. This script fills in a disambiguating `suffix` on
// each ambiguous walk by extracting a " via X" fragment from its
// source page title.
//
// Example: source.pageName = "Eynsford Circular via Farningham"
//          → v.suffix = "via Farningham"
//          → derived title renders as "Eynsford Circular via Farningham"
//
// Walks that already have a `suffix` or a `name` override are left
// alone. Walks whose source.pageName has no "via X" fragment are
// reported at the end so the admin can set a custom suffix manually.
//
// Idempotent — a walk that already has a suffix is skipped.
//
// Usage:
//   node scripts/disambiguate-walk-titles.mjs --dry-run
//   node scripts/disambiguate-walk-titles.mjs

import { readFileSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, "..")

const FILES = [
  "data/rambler-walks.json",
  "data/leicester-ramblers-walks.json",
  "data/heart-rail-trails-walks.json",
  "data/abbey-line-walks.json",
]

// CRS → station name. Mirrors the build-script lookup so derived
// titles here match exactly what the build emits.
function loadCrsIndex() {
  const stations = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "public", "stations.json"), "utf-8"),
  )
  const m = new Map()
  for (const f of stations.features) {
    const c = f.properties?.["ref:crs"]
    const n = f.properties?.name
    if (c && n) m.set(c, n)
  }
  return m
}

function derivedTitle(v, entry, crsName) {
  const start = crsName.get(v.startStation)
  const end = crsName.get(v.endStation)
  if (start && end) {
    return v.startStation === v.endStation ? `${start} Circular` : `${start} to ${end}`
  }
  return entry.title
}

// Extract "via X" from the tail of a page name. Captures the full
// trailing phrase from " via " onward so "via Hill Bottom" and
// "via Gibraltar and Ford" both resolve to their full label.
// Case-insensitive; returns the trimmed phrase (including the
// leading "via") or null.
function extractViaSuffix(pageName) {
  if (typeof pageName !== "string") return null
  const m = pageName.match(/\s+(via\s+.+?)\s*$/i)
  if (!m) return null
  // Canonicalise casing: "Via" → "via" so suffixes are consistent.
  return m[1].replace(/^Via\s+/, "via ")
}

function parseArgs(argv) {
  return { dryRun: argv.includes("--dry-run") }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const crsName = loadCrsIndex()

  // Load every walks file and build a flat list with back-references
  // so we can mutate in place.
  const loaded = FILES.map((rel) => {
    const full = join(PROJECT_ROOT, rel)
    try { return { rel, full, data: JSON.parse(readFileSync(full, "utf-8")) } }
    catch (err) {
      if (err && /ENOENT/.test(err.message)) return null
      throw err
    }
  }).filter(Boolean)

  const all = []
  for (const { data } of loaded) {
    for (const [slug, entry] of Object.entries(data)) {
      if (!Array.isArray(entry.walks)) continue
      for (const v of entry.walks) {
        // Scope: only station-to-station walks whose CRS codes resolve
        // (these are the ones the build script renders). Skip walks
        // with a name override — the admin already chose their title.
        if (!v.stationToStation) continue
        if (!crsName.has(v.startStation) || !crsName.has(v.endStation)) continue
        if ((v.name ?? "").trim()) continue
        all.push({ v, entry, slug, title: derivedTitle(v, entry, crsName) })
      }
    }
  }

  // Group walks by their derived title so we can tell which need
  // disambiguation.
  const groups = new Map()
  for (const w of all) {
    if (!groups.has(w.title)) groups.set(w.title, [])
    groups.get(w.title).push(w)
  }

  let viaAssigned = 0
  let viaSightAssigned = 0
  let alreadySuffixed = 0
  const toDelete = []   // walks marked for deletion (pass 3 couldn't find a unique sight)
  const unresolvable = [] // duplicate groups where we couldn't disambiguate further

  for (const [title, walks] of groups) {
    if (walks.length < 2) continue
    // Pass 1 — assign via-suffix from source.pageName where present.
    const results = walks.map((w) => {
      if ((w.v.suffix ?? "").trim()) {
        alreadySuffixed++
        return { w, suffix: w.v.suffix, source: "existing" }
      }
      const via = extractViaSuffix(w.v.source?.pageName)
      if (via) return { w, suffix: via, source: "via" }
      return { w, suffix: null, source: "pending" }
    })

    // Pass 2 — for walks that still have no suffix, look at their
    // sights[] list. Prefer a sight that's unique in the group (i.e.
    // no other walk in this title-group also names it); fall back to
    // the walk's first sight if all its sights are shared. This gives
    // every walk *some* distinguishing "via X" so the admin can see
    // and curate the defaults.
    const pendingIdx = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.source === "pending")
    if (pendingIdx.length > 0) {
      // Build a set of sight names seen across all OTHER walks in the
      // group (those already suffixed + pending siblings).
      for (const { r, i } of pendingIdx) {
        const sights = Array.isArray(r.w.v.sights) ? r.w.v.sights.map((s) => s.name).filter(Boolean) : []
        if (sights.length === 0) continue
        const otherSights = new Set()
        results.forEach((o, j) => {
          if (j === i) return
          for (const s of (o.w.v.sights ?? [])) otherSights.add(s.name)
        })
        const unique = sights.find((s) => !otherSights.has(s))
        const picked = unique ?? sights[0]
        r.suffix = `via ${picked}`
        r.source = "sight"
      }
    }

    // Pass 3 — walks still sharing a title after passes 1+2 are
    // resolved by one of two moves:
    //
    //   main walks     → strip any legacy type marker, keep as-is.
    //                    A main walk "wins" by default — it's the
    //                    canonical walk of its source page.
    //
    //   variant walks  → look for a sight unique within the group
    //                    (present on this walk but on none of its
    //                    siblings). If found, append " & {sight}" to
    //                    the existing via-suffix. If not found, the
    //                    walk is marked for deletion — it can't be
    //                    reliably distinguished from its siblings
    //                    and doesn't carry unique-enough content to
    //                    justify its own paragraph.
    //
    // We group by "base" (title + suffix with any pre-existing type
    // marker stripped) so prior-run "(shorter)" / "(standard version)"
    // tags don't prevent the group being detected as duplicate now.
    const typeMarkerRe = /\s*\((?:main|standard version|shorter|longer|alternative|variant)\)\s*$/
    const stripTypeMarker = (s) => (s ?? "").replace(typeMarkerRe, "").trim()

    const byBase = new Map()
    for (const r of results) {
      const base = r.suffix
        ? `${title} ${stripTypeMarker(r.suffix)}`.trim()
        : title
      if (!byBase.has(base)) byBase.set(base, [])
      byBase.get(base).push(r)
    }

    for (const [, rs] of byBase) {
      if (rs.length < 2) continue

      // Count how often each sight name appears across the group so
      // we can cheaply check uniqueness per walk.
      const groupSightCounts = new Map()
      for (const r of rs) {
        for (const s of (r.w.v.sights ?? [])) {
          if (!s?.name) continue
          groupSightCounts.set(s.name, (groupSightCounts.get(s.name) ?? 0) + 1)
        }
      }

      for (const r of rs) {
        const t = r.w.v.source?.type ?? r.w.v.role
        const isMain = t === "main"

        if (isMain) {
          // Main wins by default — drop any legacy type marker in
          // its suffix so the title reads cleanly.
          if (r.suffix && typeMarkerRe.test(r.suffix)) {
            r.suffix = stripTypeMarker(r.suffix) || null
            r.source = r.source === "existing" ? "existing+type" : "sight+type"
          }
          continue
        }

        // Variant — try to find a sight unique in the group.
        const sights = (r.w.v.sights ?? []).map((s) => s?.name).filter(Boolean)
        const uniqueSight = sights.find((s) => groupSightCounts.get(s) === 1)

        if (uniqueSight) {
          // Append " & {uniqueSight}" to the existing via-suffix,
          // stripping any legacy type marker first. If there's no
          // via yet, seed with "via {uniqueSight}".
          const stripped = stripTypeMarker(r.suffix ?? "")
          r.suffix = stripped ? `${stripped} & ${uniqueSight}` : `via ${uniqueSight}`
          r.source = r.source === "existing" ? "existing+type" : "sight+type"
        } else {
          r.deleteMe = true
          toDelete.push({
            id: r.w.v.id,
            slug: r.w.slug,
            type: t,
            sourcePage: r.w.v.source?.pageName,
            title,
          })
        }
      }
    }

    // Apply suffixes (skip "existing" — they were preserved as-is).
    // Note that pass 3 may have set r.suffix to null when stripping a
    // type marker from a main walk; in that case we want to DELETE
    // the existing suffix on disk, not just skip.
    for (const r of results) {
      if (r.source === "existing") continue
      if (r.suffix == null) {
        if (r.w.v.suffix !== undefined) delete r.w.v.suffix
      } else {
        r.w.v.suffix = r.suffix
      }
      if (r.source === "via") viaAssigned++
      else if (r.source === "sight") viaSightAssigned++
    }

    // Post-apply check: any walks in this group still share a title?
    const effective = results.map((r) => ({ ...r, effective: r.suffix ? `${title} ${r.suffix}` : title }))
    const postCounts = new Map()
    for (const r of effective) postCounts.set(r.effective, (postCounts.get(r.effective) ?? 0) + 1)
    const stillDupe = [...postCounts.entries()].filter(([, n]) => n >= 2)
    if (stillDupe.length > 0) {
      unresolvable.push({
        title,
        walks: effective.map((r) => ({
          id: r.w.v.id,
          slug: r.w.slug,
          sourcePage: r.w.v.source?.pageName,
          suffix: r.suffix ?? "(none)",
          effective: r.effective,
        })),
      })
    }
  }

  // Apply deletions: walks marked deleteMe in pass 3 get filtered out
  // of their parent entry's walks[]. We do this in a second pass to
  // avoid mutating lists while iterating. Only runs outside dry-run.
  const deleteIds = new Set(toDelete.map((d) => d.id))
  let actuallyDeleted = 0
  if (!args.dryRun && deleteIds.size > 0) {
    for (const { data } of loaded) {
      for (const entry of Object.values(data)) {
        if (!Array.isArray(entry.walks)) continue
        const before = entry.walks.length
        entry.walks = entry.walks.filter((v) => !deleteIds.has(v.id))
        actuallyDeleted += before - entry.walks.length
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Walks scanned: ${all.length}`)
  // eslint-disable-next-line no-console
  console.log(`Duplicate groups seen: ${[...groups.values()].filter((g) => g.length >= 2).length}`)
  // eslint-disable-next-line no-console
  console.log(`  suffix assigned (via …): ${viaAssigned}`)
  // eslint-disable-next-line no-console
  console.log(`  sight-based suffix:      ${viaSightAssigned}`)
  // eslint-disable-next-line no-console
  console.log(`  already had suffix:      ${alreadySuffixed}`)
  // eslint-disable-next-line no-console
  console.log(`  variants marked for deletion: ${toDelete.length}`)
  // eslint-disable-next-line no-console
  console.log(`  still-duplicate groups:  ${unresolvable.length}`)

  if (toDelete.length > 0) {
    // eslint-disable-next-line no-console
    console.log("\nVariants to delete (no unique sight distinguishing them from their duplicate siblings):")
    // group by title for readability
    const byTitle = new Map()
    for (const d of toDelete) {
      if (!byTitle.has(d.title)) byTitle.set(d.title, [])
      byTitle.get(d.title).push(d)
    }
    for (const [t, ds] of byTitle) {
      // eslint-disable-next-line no-console
      console.log(`  ${t}`)
      for (const d of ds) {
        // eslint-disable-next-line no-console
        console.log(`    ${d.id} (${d.slug}) · ${d.type} · source="${d.sourcePage}"`)
      }
    }
  }

  if (unresolvable.length > 0) {
    // eslint-disable-next-line no-console
    console.log("\nStill ambiguous — set a custom suffix via admin:")
    for (const u of unresolvable) {
      // eslint-disable-next-line no-console
      console.log(`  ${u.title}`)
      for (const w of u.walks) {
        // eslint-disable-next-line no-console
        console.log(`    ${w.id} (${w.slug}) · source="${w.sourcePage}" · suffix=${w.suffix}`)
      }
    }
  }

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log("\n--dry-run: not writing.")
    return
  }

  for (const { full, data } of loaded) {
    writeFileSync(full, JSON.stringify(data, null, 2) + "\n", "utf-8")
  }
  // eslint-disable-next-line no-console
  console.log(`\nWrote ${loaded.length} files. Deleted ${actuallyDeleted} walk variants.`)
}

main()
