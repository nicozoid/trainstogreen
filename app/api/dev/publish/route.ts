import { NextResponse } from "next/server"

// Triggers a Vercel rebuild of the production deployment. Pairs with
// vercel.json's ignoreCommand, which skips automatic builds for commits
// that only touch data/*.json files — so admin edits queue up on main
// without auto-redeploying, then this endpoint flushes them when the
// user hits "Publish" in the admin UI.
//
// Env vars:
//  - VERCEL_DEPLOY_HOOK_URL: the POST-able Deploy Hook URL created in
//    Vercel → Project → Settings → Git → Deploy Hooks.
//  - VERCEL_GIT_COMMIT_SHA: set automatically by Vercel on every build;
//    identifies the commit this running deployment was built from.
//    Used by GET to detect unpublished commits on main.

const OWNER = "nicozoid"
const REPO = "trainstogreen"

// GET — report whether there are commits on main newer than the
// currently-running deployment's commit. Returns `pending` (boolean)
// and `count` (number of unpublished commits, capped at 30 by the
// GitHub compare API's per_page default).
export async function GET() {
  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL
  const deployedSha = process.env.VERCEL_GIT_COMMIT_SHA
  const token = process.env.GITHUB_TOKEN

  // Locally (no Vercel env) there's nothing to publish — admin edits
  // are already written to disk. Return pending=false so the button
  // stays quiet in dev.
  if (!deployedSha) {
    return NextResponse.json({ pending: false, count: 0, configured: Boolean(hookUrl) })
  }

  // Compare deployedSha..main. `ahead_by` tells us how many commits
  // main has that the current deployment doesn't.
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/compare/${deployedSha}...main`,
    {
      headers: {
        Accept: "application/vnd.github.v3+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // No caching — admins need the live state.
      cache: "no-store",
    }
  )

  if (!res.ok) {
    return NextResponse.json(
      { pending: false, count: 0, error: `GitHub compare failed (${res.status})` },
      { status: 200 }
    )
  }

  const json = (await res.json()) as { ahead_by?: number }
  const count = json.ahead_by ?? 0
  return NextResponse.json({
    pending: count > 0,
    count,
    configured: Boolean(hookUrl),
  })
}

// POST — trigger a new Vercel build by hitting the Deploy Hook URL.
// The hook URL itself is the secret (anyone with the URL can trigger
// a build), so we keep it server-side in an env var.
export async function POST() {
  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL
  if (!hookUrl) {
    return NextResponse.json(
      { error: "VERCEL_DEPLOY_HOOK_URL not set" },
      { status: 500 }
    )
  }

  const res = await fetch(hookUrl, { method: "POST" })
  if (!res.ok) {
    return NextResponse.json(
      { error: `Deploy hook returned ${res.status}` },
      { status: 502 }
    )
  }
  return NextResponse.json({ ok: true })
}
