import { NextResponse } from "next/server"
import { loadAllWalks } from "@/lib/walk-payload"

// Returns every walk variant in the unified data file as a flat array
// of WalkPayload, no filtering or sort applied. Drives the walks-
// manager admin pages (table view + per-walk standalone editor).
//
// Admin-only — gated by the dev middleware higher up in the stack.
// Heavier than walks-for-station (no CRS filter), but the walks-
// manager view needs every walk anyway, and the file is small enough
// (a few hundred KB at present) that the round-trip stays fast.
export async function GET() {
  const walks = await loadAllWalks()
  return NextResponse.json(walks)
}
