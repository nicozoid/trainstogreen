"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import type { User } from "@supabase/supabase-js"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function AuthButton() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [open, setOpen] = useState(false)

  // Toggle between "sign in" and "sign up" mode within the same dialog
  const [mode, setMode] = useState<"signin" | "signup">("signin")

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // After sign up, we ask the user to check their email before showing the form again
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user))

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault() // Prevent the browser's default form submission (page reload)
    setError(null)
    setLoading(true)

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({ email, password })
      if (error) {
        setError(error.message)
      } else {
        setAwaitingConfirmation(true)
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setError(error.message)
      } else {
        setOpen(false)
        // Reset form state after successful sign in
        setEmail("")
        setPassword("")
      }
    }

    setLoading(false)
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  function openDialog(initialMode: "signin" | "signup") {
    setMode(initialMode)
    setError(null)
    setAwaitingConfirmation(false)
    setEmail("")
    setPassword("")
    setOpen(true)
  }

  if (user === undefined) return null

  // Signed-in state: show their email and a sign out button
  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{user.email}</span>
        <Button variant="ghost" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </div>
    )
  }

  // Signed-out state: show sign in button and trigger the dialog
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => openDialog("signin")}>
        Sign in
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {mode === "signin" ? "Sign in" : "Create an account"}
            </DialogTitle>
            <DialogDescription>
              {mode === "signin"
                ? "Sign in to save your station ratings."
                : "Create an account to save your station ratings."}
            </DialogDescription>
          </DialogHeader>

          {awaitingConfirmation ? (
            // Shown after sign up — Supabase sends a confirmation email before activating the account
            <p className="text-sm text-muted-foreground">
              Check your email for a confirmation link, then come back and sign in.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
              </div>

              {/* Show any error returned by Supabase (wrong password, etc.) */}
              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" disabled={loading}>
                {loading ? "..." : mode === "signin" ? "Sign in" : "Create account"}
              </Button>

              {/* Toggle between sign in and sign up */}
              <p className="text-center text-sm text-muted-foreground">
                {mode === "signin" ? "No account?" : "Already have an account?"}{" "}
                <button
                  type="button" // Prevents this from accidentally submitting the form
                  className="underline"
                  onClick={() => {
                    setMode(mode === "signin" ? "signup" : "signin")
                    setError(null)
                  }}
                >
                  {mode === "signin" ? "Sign up" : "Sign in"}
                </button>
              </p>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
