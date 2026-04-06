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
const BRANCH = "main"

// When GITHUB_TOKEN is set, we use the GitHub API instead of the filesystem
function getToken(): string | undefined {
  return process.env.GITHUB_TOKEN
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

  // Production — fetch from GitHub Contents API
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${relativePath}?ref=${BRANCH}`, {
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
  // GitHub returns the file content as base64
  const content = Buffer.from(json.content, "base64").toString("utf-8")
  return { data: JSON.parse(content) as T, sha: json.sha }
}

/**
 * Write a JSON data file. Locally this writes to disk. In production it
 * creates a commit on main via the GitHub Contents API.
 *
 * The `sha` parameter (from readDataFile) is required in production — GitHub
 * uses it to prevent conflicts. If another commit changed the file since you
 * read it, the write fails with a 409 instead of silently overwriting.
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
    throw new Error(`GitHub API write failed (${res.status}): ${body}`)
  }
}
