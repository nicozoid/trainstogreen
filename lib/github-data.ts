/**
 * Abstracts reading/writing JSON data files.
 *
 * - Locally (no GITHUB_TOKEN): uses the filesystem directly, same as before.
 * - In production (GITHUB_TOKEN set): reads and writes via the GitHub Contents
 *   API, creating a commit on main for each write. This means admin edits on
 *   the deployed site persist in the repo and can be pulled locally.
 */

import fs from "fs"
import path from "path"

const OWNER = "nicozoid"
const REPO = "trainstogreen"
// Branch to read data files from (and commit writes to) when running on the
// deployed site. Defaults to "main" in production and local dev; Vercel
// preview deploys populate VERCEL_GIT_COMMIT_REF with the deploy's branch
// name, so previews read branch-local data (e.g. station-notes.json edits
// in a PR branch show up on that PR's preview deploy, rather than the
// preview reading main's copy).
//
// Writes from a preview go to the SAME branch the preview reads from, so
// admin edits made inside a preview deploy stick with that branch until
// the PR merges. Writes from a production main deploy still land on main.
const BRANCH = process.env.VERCEL_GIT_COMMIT_REF ?? "main"

// When GITHUB_TOKEN is set, we use the GitHub API instead of the filesystem
function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN
}

/**
 * Thrown when a GitHub PUT returns 409/422 — i.e. the file's SHA has changed
 * since we read it. The retry helper (`writeWithRetry`) catches this and
 * re-runs the read/mutate/write cycle. Caller code shouldn't normally see it.
 */
export class ConflictError extends Error {
  constructor(message = "GitHub SHA conflict") {
    super(message)
    this.name = "ConflictError"
  }
}

/**
 * Read a JSON data file. Returns the parsed data and (in production) the
 * file's current SHA, which is needed to update it without conflicts.
 */
export async function readDataFile<T>(relativePath: string): Promise<{ data: T; sha: string | null }> {
  const token = getToken()

  if (!token) {
    // Local dev — read from disk
    const fullPath = path.join(process.cwd(), relativePath)
    const raw = fs.readFileSync(fullPath, "utf-8")
    return { data: JSON.parse(raw) as T, sha: null }
  }

  // Production — fetch from GitHub Contents API.
  //
  // We resolve the branch's HEAD commit SHA via the Git Data API
  // FIRST, then pin the contents read to that SHA via `?ref={sha}`
  // instead of `?ref={branch}`.
  //
  // Why: the branch-name read path is served through GitHub's CDN
  // cache, which can return a stale snapshot for several seconds
  // after a write. Within that staleness window, a fresh PATCH
  // would read pre-write content + the pre-write blob SHA, modify
  // its target field on that stale state, and then commit the whole
  // file back — silently reverting any concurrent edit that landed
  // moments earlier in another commit. The SHA-mismatch retry
  // doesn't fire because the cache returned a self-consistent
  // (stale content, stale SHA) pair that GitHub's PUT accepts.
  //
  // Pinning to an immutable commit SHA bypasses the branch-name
  // cache entirely, so the read always reflects the latest
  // committed state. Costs one extra round-trip per read; admin-
  // only path so the latency is fine.
  const refRes = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
      cache: "no-store",
    },
  )
  if (!refRes.ok) {
    throw new Error(`GitHub refs read failed (${refRes.status}): ${await refRes.text()}`)
  }
  const refJson = await refRes.json()
  const headSha = refJson?.object?.sha
  if (typeof headSha !== "string" || !headSha) {
    throw new Error(`GitHub refs read returned no SHA for ${BRANCH}`)
  }

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${relativePath}?ref=${headSha}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
    cache: "no-store", // always get the latest version
  })

  if (!res.ok) {
    throw new Error(`GitHub API read failed (${res.status}): ${await res.text()}`)
  }

  const json = await res.json()
  // The Contents API's inline base64 `content` field is capped at 1MB;
  // files above that size come back with `content: ""` plus a
  // `download_url` pointing at the raw blob. Use that fallback so we
  // can read the (bigger) build outputs like station-notes.json.
  let content: string
  if (typeof json.content === "string" && json.content.length > 0) {
    content = Buffer.from(json.content, "base64").toString("utf-8")
  } else if (typeof json.download_url === "string" && json.download_url) {
    const dl = await fetch(json.download_url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
    if (!dl.ok) {
      throw new Error(`GitHub raw read failed (${dl.status}) for ${relativePath}`)
    }
    content = await dl.text()
  } else {
    throw new Error(`GitHub API returned no content and no download_url for ${relativePath}`)
  }
  return { data: JSON.parse(content) as T, sha: json.sha }
}

/**
 * Write a JSON data file. Locally this writes to disk. In production it
 * creates a commit on main via the GitHub Contents API.
 *
 * The `sha` parameter (from readDataFile) is required in production — GitHub
 * uses it to prevent conflicts. If another commit changed the file since you
 * read it, the write throws ConflictError instead of silently overwriting.
 * Callers that want automatic retry should use `writeWithRetry` instead.
 */
export async function writeDataFile<T>(
  relativePath: string,
  data: T,
  commitMessage: string,
  sha: string | null
): Promise<void> {
  const token = getToken()
  const content = JSON.stringify(data, null, 2) + "\n"

  if (!token) {
    // Local dev — write to disk
    const fullPath = path.join(process.cwd(), relativePath)
    fs.writeFileSync(fullPath, content, "utf-8")
    return
  }

  // Production — commit via GitHub Contents API
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${relativePath}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(content).toString("base64"),
      sha, // required — prevents silent overwrites
      branch: BRANCH,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    // GitHub returns 409 for SHA mismatch and 422 for "does not match" — both
    // mean someone else committed in between. Convert to typed error so the
    // retry helper can catch it specifically.
    if (res.status === 409 || res.status === 422) {
      throw new ConflictError(`GitHub PUT ${res.status}: ${body}`)
    }
    throw new Error(`GitHub API write failed (${res.status}): ${body}`)
  }
}

/**
 * Read → mutate → write cycle with automatic conflict retry. Pass a `mutate`
 * function that receives the current parsed data and returns the new value
 * plus a commit message. If the write 409s (someone else committed in the
 * meantime), we re-read the file and re-run `mutate` against the latest
 * state, up to 3 times. After that we give up and re-throw ConflictError.
 *
 * This makes the vast majority of admin actions conflict-free without any
 * client-side logic — the few times two writes race, the second one just
 * sees the latest state and reapplies its mutation cleanly.
 */
export async function writeWithRetry<T>(
  relativePath: string,
  mutate: (current: T) => { next: T; message: string },
): Promise<void> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data, sha } = await readDataFile<T>(relativePath)
    const { next, message } = mutate(data)
    try {
      await writeDataFile(relativePath, next, message, sha)
      return
    } catch (e) {
      lastErr = e
      if (e instanceof ConflictError) {
        // SHA changed between our read and write — try again with fresh data.
        continue
      }
      throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new ConflictError("retry exhausted")
}
