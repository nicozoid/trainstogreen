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

export async function POST(req: NextRequest) {
  const { key, payload } = await req.json()

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
    const body = JSON.stringify(payload)
    await fs.writeFile(filePath, body, "utf8")
    return NextResponse.json({
      message: `saved ${key}.json`,
      path: `/routing/${key}.json`,
      bytes: body.length,
    })
  } catch (err) {
    return NextResponse.json(
      { error: "write failed", detail: String(err) },
      { status: 500 },
    )
  }
}
