import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Lock all `/api/dev/*` mutations to local development. The dev API is
// what the admin UI uses to write back to data/ via GitHub — every
// write triggers a Vercel rebuild, so leaving it open in production
// both burns the deploy rate-limit and lets anyone mutate data by
// calling these routes directly (admin activation is client-only
// gated; the routes themselves have no auth of their own).
//
// GETs remain open because public features depend on them (e.g. the
// station-notes fetch that powers the public ramblerNote prose in
// every station overlay). Only state-changing verbs are blocked.
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"])

export function middleware(req: NextRequest) {
  if (process.env.NODE_ENV === "development") return
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return
  return NextResponse.json(
    { error: "admin mutations only available in local development" },
    { status: 404 },
  )
}

export const config = {
  // Matcher runs the middleware only for routes under /api/dev so we
  // don't pay the middleware cost on every request.
  matcher: "/api/dev/:path*",
}
