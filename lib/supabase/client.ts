import { createBrowserClient } from "@supabase/ssr"

// This client runs in the browser (inside React components).
// It reads your Supabase URL and public anon key from environment variables.
// The anon key is safe to expose — it only grants access based on your
// Row Level Security rules (which we'll set up in Supabase).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
