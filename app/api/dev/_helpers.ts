import { NextResponse } from "next/server"
import { ConflictError, commitMultipleDataFiles } from "@/lib/github-data"
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

/**
 * Save a walk: commit the source walk file AND the rebuilt derived
 * station-* files in a SINGLE commit. Called after every walk save
 * (create/edit/delete) so the public view (which reads
 * station-notes.json) stays in sync with the walk data without anyone
 * having to remember to run the build script and stage the result.
 *
 * Why one bundled commit instead of one-per-file:
 * - Each commit on a non-main branch triggers its own Vercel preview
 *   deploy. Saving one walk used to produce 5 commits (source +
 *   4 derived) → 5 stacked previews. Bundling makes it 1 deploy.
 * - The save is also more atomic: derived files can't get out of sync
 *   with the source file because they all land in the same commit.
 *
 * In local dev (no GITHUB_TOKEN) this just writes each file straight
 * to disk via fs.writeFileSync — no git involvement. Same net effect
 * as the build script, just routed through one path.
 */
export async function commitWalkSave(
  sourceFile: { path: string; data: unknown },
  baseMessage: string,
): Promise<void> {
  // returnData: true makes buildRamblerNotes return the computed
  // datasets instead of writing files; the non-null assertion below is
  // safe because of that flag (the script only returns undefined in
  // its CLI/file-write mode).
  const built = (await buildRamblerNotes({
    dryRun: false,
    flipOnMap: false,
    returnData: true,
  }))!

  await commitMultipleDataFiles(
    [
      sourceFile,
      { path: "data/station-notes.json", data: built.notes },
      { path: "data/station-seasons.json", data: built.seasons },
      { path: "data/stations-hiked.json", data: built.hiked },
      { path: "data/stations-with-komoot.json", data: built.komoot },
    ],
    baseMessage,
  )
}
