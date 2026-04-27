import { NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

// Lists the last ~50 commits to `data/*.json` so the admin "Edits" dialog
// can show what's recently been saved. Two backing implementations:
//
// - In production (GITHUB_TOKEN set): hits the GitHub commits API filtered
//   to the data/ path. Authoritative and survives a redeploy.
// - In local dev: shells out to `git log` for the same info. Useful when
//   testing the dialog without a token.
//
// Returns: [{ sha, message, author, dateISO, filesChanged: string[], url }]

const OWNER = "nicozoid"
const REPO = "trainstogreen"
const BRANCH = process.env.VERCEL_GIT_COMMIT_REF ?? "main"
const LIMIT = 50

type EditRow = {
  sha: string
  message: string
  author: string
  dateISO: string
  filesChanged: string[]
  url: string
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN
  try {
    const rows = token ? await fetchFromGitHub(token) : await fetchFromLocalGit()
    return NextResponse.json(rows)
  } catch (e) {
    console.error("recent-edits failed:", e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

// GitHub commits API supports `?path=data` to filter to commits that touched
// files under `data/`. We hit that, then fan out per-commit to fetch the
// list of files changed (so the UI can show "photo-curations.json" etc.).
async function fetchFromGitHub(token: string): Promise<EditRow[]> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/commits?sha=${BRANCH}&path=data&per_page=${LIMIT}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
    cache: "no-store",
  })
  if (!res.ok) {
    throw new Error(`GitHub commits API ${res.status}: ${await res.text()}`)
  }
  const list = (await res.json()) as Array<{
    sha: string
    html_url: string
    commit: {
      message: string
      author: { name: string; date: string }
    }
  }>

  // Fetch the per-commit file list. GitHub returns this in a separate
  // endpoint; we run them in parallel but cap concurrency at 8 to avoid
  // hammering the API. For 50 commits @ 8 in flight that's ~6 batches.
  const rows: EditRow[] = []
  for (let i = 0; i < list.length; i += 8) {
    const batch = list.slice(i, i + 8)
    const detailed = await Promise.all(
      batch.map(async (c) => {
        const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${c.sha}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.v3+json" },
          cache: "no-store",
        })
        if (!r.ok) return null
        const j = (await r.json()) as { files?: Array<{ filename: string }> }
        return {
          sha: c.sha,
          message: c.commit.message.split("\n")[0],
          author: c.commit.author.name,
          dateISO: c.commit.author.date,
          filesChanged: (j.files ?? []).map((f) => f.filename).filter((p) => p.startsWith("data/")),
          url: c.html_url,
        }
      }),
    )
    for (const r of detailed) if (r) rows.push(r)
  }
  return rows
}

// Local-dev fallback. Mirrors the same shape from `git log --name-only`.
// Skipped in production because Vercel's runtime fs doesn't have the
// .git directory checked out on the lambda image.
async function fetchFromLocalGit(): Promise<EditRow[]> {
  // Verify .git exists — otherwise the dialog should just be empty rather
  // than blowing up with a confusing exec error.
  if (!fs.existsSync(path.join(process.cwd(), ".git"))) return []

  // Format: header line (SHA, ISO date, author, subject — tab-separated)
  // followed by one file path per line, with a blank line between commits.
  // We deliberately avoid `-z` because it NUL-separates EVERY file, not
  // just commits, which makes the boundary ambiguous.
  const out = execSync(
    `git log -n ${LIMIT} --pretty=format:%H%x09%aI%x09%an%x09%s --name-only -- data/`,
    { cwd: process.cwd(), encoding: "utf-8" },
  )
  const records = out.split("\n\n").map((r) => r.trim()).filter(Boolean)
  const rows: EditRow[] = []
  for (const rec of records) {
    const lines = rec.split("\n").filter(Boolean)
    const head = lines[0]
    const files = lines.slice(1)
    const [sha, dateISO, author, ...msgParts] = head.split("\t")
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue
    rows.push({
      sha,
      message: msgParts.join("\t"),
      author,
      dateISO,
      filesChanged: files.filter((p) => p.startsWith("data/")),
      url: `https://github.com/${OWNER}/${REPO}/commit/${sha}`,
    })
  }
  return rows
}
