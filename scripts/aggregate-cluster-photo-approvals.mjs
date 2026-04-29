#!/usr/bin/env node
// Roll up each cluster member's APPROVED photos under the synthetic
// anchor in data/photo-curations.json so the cluster modal's gallery
// shows everything its members showcase. Pinned-IDs and ordering are
// NOT touched — only the approved-set membership.
//
// Idempotent: re-running after a new cluster appears (or after an admin
// approves a new photo on a member station) propagates only the deltas.
//
// Run after editing lib/clusters-data.json. Already part of the cluster
// conversion workflow — see memory/cluster_conversion_workflow.md.

import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CLUSTERS_PATH = join(PROJECT_ROOT, "lib", "clusters-data.json")
const CURATIONS_PATH = join(PROJECT_ROOT, "data", "photo-curations.json")

const { CLUSTERS } = JSON.parse(readFileSync(CLUSTERS_PATH, "utf-8"))
const curations = JSON.parse(readFileSync(CURATIONS_PATH, "utf-8"))

let anchorsTouched = 0
let photosAdded = 0

for (const [anchorCoord, def] of Object.entries(CLUSTERS)) {
  // Collect all member-approved photos in declared member order.
  const memberApproved = []
  for (const memberCoord of def.members) {
    const m = curations[memberCoord]
    if (!m || !Array.isArray(m.approved)) continue
    for (const photo of m.approved) memberApproved.push(photo)
  }
  if (memberApproved.length === 0) continue

  // Existing anchor entry — preserve its approved list and pinnedIds
  // exactly. We only ADD new photos to the end (in declared member
  // order, then file order within each member). Ordering and pins for
  // photos already present at the anchor stay put.
  const existing = curations[anchorCoord] ?? {
    name: def.displayName,
    approved: [],
    pinnedIds: [],
  }
  const existingIds = new Set((existing.approved ?? []).map((p) => p.id))
  const additions = []
  const seenInAdditions = new Set()
  for (const photo of memberApproved) {
    if (existingIds.has(photo.id)) continue
    if (seenInAdditions.has(photo.id)) continue // dedupe across members
    seenInAdditions.add(photo.id)
    additions.push(photo)
  }
  if (additions.length === 0) continue

  curations[anchorCoord] = {
    ...existing,
    name: def.displayName, // keep anchor name in sync with cluster registry
    approved: [...(existing.approved ?? []), ...additions],
    pinnedIds: existing.pinnedIds ?? [],
  }
  anchorsTouched++
  photosAdded += additions.length
  // eslint-disable-next-line no-console
  console.log(`  ${def.displayName} (${anchorCoord}): +${additions.length} approved`)
}

if (anchorsTouched === 0) {
  // eslint-disable-next-line no-console
  console.log("Nothing to transfer — every cluster anchor already has its members' approvals.")
} else {
  writeFileSync(CURATIONS_PATH, JSON.stringify(curations, null, 2) + "\n")
  // eslint-disable-next-line no-console
  console.log(`\n${anchorsTouched} anchors updated, ${photosAdded} photos added.`)
}
