import { NextResponse } from "next/server"
import { ConflictError } from "@/lib/github-data"

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
