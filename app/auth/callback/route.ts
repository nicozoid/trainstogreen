import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

// After the user signs in with Google, they get redirected here.
// Supabase includes a one-time `code` in the URL — we exchange it for a real session,
// then send the user to the home page.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")

  if (code) {
    const supabase = await createClient()
    await supabase.auth.exchangeCodeForSession(code)
  }

  return NextResponse.redirect(origin)
}
