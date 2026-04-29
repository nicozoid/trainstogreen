import { NextResponse } from "next/server"
import { ConflictError, readDataFile, writeDataFile } from "@/lib/github-data"
import { buildRamblerNotes } from "@/scripts/build-rambler-notes.mjs"

/**
 * Wraps an admin-write route handler with automatic conflict-retry and
 * normalized error responses.
 *
 * Most admin routes follow a read → mutate → write pattern against a single
 * `data/*.json` file. If two writes race, GitHub rejects the second with a
 * SHA-mismatch error (surfaced as ConflictError by `lib/github-data`). This
 * wrapper catches that and re-runs the whole handler, which causes a fresh
 * read of the file and a fresh mutation against the latest state. After
 * MAX_ATTEMPTS we give up and surface a 409 to the client.
 *
 * The handler must be safely re-runnable: don't mutate inputs, don't perform
 * non-idempotent side effects outside the JSON write itself. Reading the
 * request body (`await req.json()`) must happen OUTSIDE this wrapper, because
 * the body stream can only be consumed once.
 *
 * Non-conflict errors are caught, logged, and returned as JSON 500s so the
 * outbox drainer on the client gets a predictable shape.
 */
export async function handleAdminWrite(
  handler: () => Promise<Response>,
): Promise<Response> {
  const MAX_ATTEMPTS = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await handler()
    } catch (e) {
      lastErr = e
      if (e instanceof ConflictError) continue
      console.error("admin write failed:", e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "save failed" },
        { status: 500 },
      )
    }
  }
  console.error("admin write conflict-retry exhausted:", lastErr)
  return NextResponse.json(
    { error: "conflict — please retry" },
    { status: 409 },
  )
}

// Files written by buildRamblerNotes — kept here so route handlers
// don't have to know the paths.
const DERIVED_FILES = {
  notes: "data/station-notes.json",
  seasons: "data/station-seasons.json",
  hiked: "data/stations-hiked.json",
  komoot: "data/stations-with-komoot.json",
} as const

/**
 * Rebuild the derived station-* files in-process and commit each one
 * via writeDataFile. Called after every walk save (create/edit/delete)
 * so the public view (which reads station-notes.json) stays in sync
 * with the walk data without anyone having to remember to run the
 * build script and stage the result.
 *
 * Why writeDataFile rather than letting the script writeFileSync:
 * - In production (Vercel) the filesystem is read-only, so the script's
 *   writeFileSync would EROFS. writeDataFile commits via the GitHub
 *   Contents API instead.
 * - In local dev writeDataFile falls through to fs.writeFileSync — same
 *   net effect as the script, just routed through one path.
 *
 * Each derived file is committed independently (own sha, own commit).
 * That's a few extra commits per walk save — acceptable for now since
 * the alternative (one commit with multiple files) needs the GitHub
 * tree API and a bigger change to writeDataFile.
 */
export async function commitDerivedFiles(baseMessage: string): Promise<void> {
  // returnData: true makes buildRamblerNotes return the computed
  // datasets instead of writing files; the non-null assertion below is
  // safe because of that flag (the script only returns undefined in
  // its CLI/file-write mode).
  const built = (await buildRamblerNotes({
    dryRun: false,
    flipOnMap: false,
    returnData: true,
  }))!
  const payloads = {
    notes: built.notes,
    seasons: built.seasons,
    hiked: built.hiked,
    komoot: built.komoot,
  } as const

  for (const [key, path] of Object.entries(DERIVED_FILES)) {
    const next = payloads[key as keyof typeof payloads]
    // Fresh sha per file — GitHub rejects writes whose sha doesn't
    // match the file's current state, so we re-read just before each
    // commit. Cheap (one HEAD-equivalent request) and keeps us
    // resilient to concurrent edits.
    const { sha } = await readDataFile<unknown>(path)
    await writeDataFile(path, next, `${baseMessage} — ${path.split("/").pop()}`, sha)
  }
}
