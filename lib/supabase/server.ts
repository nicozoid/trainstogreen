import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// This client runs on the server (in Server Components, middleware, API routes).
// It reads cookies to restore the user's session — that's how it knows who's logged in
// without them having to sign in on every page load.
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // setAll can be called from a Server Component, which can't set cookies.
            // This is fine — the middleware below handles refreshing the session.
          }
        },
      },
    },
  )
}
