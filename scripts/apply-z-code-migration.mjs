#!/usr/bin/env node
// Atomically applies the Z-code migration across the codebase:
//   - public/stations.json: rewrites every non-allowlist Z-prefix
//     ref:crs value to its new 4-character synthetic ID
//   - All other text files in tracked directories: replaces every
//     whole-word occurrence of an old Z-code with its new ID
//
// Run AFTER generating the mapping:
//   node scripts/generate-z-code-migration.mjs > /tmp/z-migration.json
//   node scripts/apply-z-code-migration.mjs /tmp/z-migration.json
//
// Allowlist (real ATOC CRS that happen to start with Z) is left
// untouched: ZFD, ZLW, ZEL, ZCW, ZTU.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")

const mappingPath = process.argv[2]
if (!mappingPath) {
  console.error("Usage: apply-z-code-migration.mjs <mapping.json>")
  process.exit(1)
}

const mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"))
const oldCodes = Object.keys(mapping)
console.error(`Loaded ${oldCodes.length} migrations from ${mappingPath}`)

// 1) Rewrite ref:crs values in public/stations.json AND
//    data/stations.fat.json directly (so the JSON structure stays
//    preserved — we only touch field values). The fat file is a
//    reference backup with the same feature shapes; both must move
//    in lockstep or RTT-build scripts that read the fat file will
//    desync from the runtime that reads the slim file.
function rewriteRefCrs(filePath) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"))
  let n = 0
  for (const f of json.features) {
    const old = f.properties["ref:crs"]
    if (old && mapping[old]) {
      f.properties["ref:crs"] = mapping[old]
      n++
    }
  }
  fs.writeFileSync(filePath, JSON.stringify(json) + "\n")
  return n
}
console.error(`stations.json: rewrote ${rewriteRefCrs(path.join(ROOT, "public/stations.json"))} ref:crs values`)
console.error(`stations.fat.json: rewrote ${rewriteRefCrs(path.join(ROOT, "data/stations.fat.json"))} ref:crs values`)

// 2) For every other file in tracked extensions, do a textual
//    whole-word replacement of each old Z-code with its new ID. We
//    use whole-word boundaries so e.g. "USSQ" doesn't match "ZSON" if
//    such a string appears anywhere.
const exts = new Set([".ts", ".tsx", ".mjs", ".js", ".json", ".md"])
const skipDirs = new Set(["node_modules", ".next", ".git"])
const skipFiles = new Set(["stations.json", "stations.fat.json", "package-lock.json"])

// Build one big alternation regex; that's faster than 241 separate passes.
const re = new RegExp(`\\b(${oldCodes.join("|")})\\b`, "g")

let filesTouched = 0
let totalReplacements = 0

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(ent.name)) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full)
    else if (exts.has(path.extname(ent.name)) && !skipFiles.has(ent.name)) {
      const txt = fs.readFileSync(full, "utf8")
      let count = 0
      const out = txt.replace(re, (m) => {
        count++
        return mapping[m] ?? m
      })
      if (count > 0) {
        fs.writeFileSync(full, out)
        filesTouched++
        totalReplacements += count
        const rel = path.relative(ROOT, full)
        console.error(`  ${rel}: ${count} replacements`)
      }
    }
  }
}

walk(ROOT)
console.error()
console.error(`Done. Touched ${filesTouched} files, ${totalReplacements} replacements.`)
