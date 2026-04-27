import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Cloud-admin write policy.
//
// Most admin actions write to `data/*.json` files that the app reads FRESH
// from GitHub on every request — so a write commits to main, doesn't
// trigger a Vercel rebuild (vercel.json's ignoreCommand skips data-only
// commits), and is immediately live for everyone. That makes them safe to
// run on the deployed cloud site.
//
// A small number of admin endpoints write to data files that ARE imported
// directly into the React bundle (e.g. excluded-stations.json,
// origin-routes.json). Those need a fresh build to take effect — they
// would silently appear "not to work" on the cloud admin until the next
// deploy. To keep cloud admin honest we block those endpoints in
// production; do them from local dev where they take effect immediately.
//
// GETs are always open — public reads (station-notes, ratings, etc.)
// power the public site. Only mutating verbs are gated.
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"])

// Endpoints whose writes touch BUNDLED files. Path matching uses
// `startsWith` so `/api/dev/walk/anything` would still pass — only exact
// equality with one of these shuts the door. Keep this list short and
// audit it whenever a route's underlying data file is added to/removed
// from imports in the React bundle.
const BUNDLED_FILE_ENDPOINTS = new Set([
  "/api/dev/exclude-station",
  "/api/dev/include-station",
  "/api/dev/save-routing",
  "/api/dev/delete-routing",
])

export function middleware(req: NextRequest) {
  if (process.env.NODE_ENV === "development") return
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return
  if (!BUNDLED_FILE_ENDPOINTS.has(req.nextUrl.pathname)) return
  return NextResponse.json(
    {
      error:
        "this admin action edits a file that's bundled into the deployed build, " +
        "so it can only be run from local dev — please make this change locally and push.",
    },
    { status: 403 },
  )
}

export const config = {
  // Matcher runs the middleware only for routes under /api/dev so we
  // don't pay the middleware cost on every request.
  matcher: "/api/dev/:path*",
}
