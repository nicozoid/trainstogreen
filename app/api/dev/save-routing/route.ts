/**
 * Dev-only endpoint that saves a precomputed routing snapshot to
 * `public/routing/<key>.json`. The snapshot is whatever the browser's
 * routedStations useMemo currently produced — POSTing the full payload
 * here persists it to disk so that subsequent page loads can skip the
 * heavy in-browser compute and just fetch the static file.
 *
 * Only works in local dev (process.cwd() must be writable). Production
 * serves the committed snapshot from the repo; regenerating it is a
 * local-dev operation followed by a git commit.
 */

import { NextRequest, NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

// Count entries that have a non-empty `journeys` object. We count the
// TOTAL number of (coord, origin) journey pairs so primaries like
// central-london with multiple origin keys per coord get counted fairly.
function countJourneyEntries(payload: unknown): number {
  if (payload == null || typeof payload !== "object") return 0
  let n = 0
  for (const v of Object.values(payload as Record<string, unknown>)) {
    if (v && typeof v === "object" && "journeys" in v) {
      const j = (v as { journeys?: Record<string, unknown> }).journeys
      if (j && typeof j === "object") n += Object.keys(j).length
    }
  }
  return n
}

export async function POST(req: NextRequest) {
  const { key, payload, force } = await req.json()

  // Basic validation — key must be a safe filename fragment and payload
  // must be JSON-serializable (we re-stringify anyway).
  if (!key || typeof key !== "string" || !/^[a-z0-9-]+$/i.test(key)) {
    return NextResponse.json({ error: "invalid key" }, { status: 400 })
  }
  if (payload == null || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 })
  }

  try {
    const dir = path.join(process.cwd(), "public", "routing")
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${key}.json`)

    // Safety check — if an existing file has substantially more journey
    // entries than the incoming payload, refuse the write. This guards
    // against a regen run that completed with partial data (e.g. the
    // routedStations memo hadn't fully populated before the regen loop
    // sampled routedStationsRef.current) silently overwriting a healthy
    // snapshot. A real coverage reduction can be forced with `force:true`.
    try {
      const existing = await fs.readFile(filePath, "utf8")
      const existingPayload = JSON.parse(existing)
      const existingCount = countJourneyEntries(existingPayload)
      const incomingCount = countJourneyEntries(payload)
      // Only guard non-trivial files. Threshold: reject if incoming is
      // below 90% of existing. Empirically a healthy regen reproduces
      // the exact same count; a corrupted run drops hundreds.
      if (!force && existingCount >= 100 && incomingCount < existingCount * 0.9) {
        return NextResponse.json(
          {
            error: "journey-count regression",
            detail:
              `Refusing to overwrite ${key}.json — existing file has ` +
              `${existingCount} journey entries, incoming payload has ` +
              `${incomingCount} (drop of ${existingCount - incomingCount}). ` +
              `This usually means the regen compute hadn't finished before ` +
              `the snapshot was taken. Re-run, or pass {force:true} to bypass.`,
            existingCount,
            incomingCount,
          },
          { status: 409 },
        )
      }
    } catch (err) {
      // ENOENT is fine — first write. Any other error, fall through to
      // the write attempt so we don't block on a transient fs hiccup.
      if (!(err instanceof Error) || !/ENOENT/.test(err.message)) {
        // Not readable as JSON → treat as missing (overwrite is OK).
      }
    }

    const body = JSON.stringify(payload)
    await fs.writeFile(filePath, body, "utf8")
    return NextResponse.json({
      message: `saved ${key}.json`,
      path: `/routing/${key}.json`,
      bytes: body.length,
      journeyCount: countJourneyEntries(payload),
    })
  } catch (err) {
    return NextResponse.json(
      { error: "write failed", detail: String(err) },
      { status: 500 },
    )
  }
}
