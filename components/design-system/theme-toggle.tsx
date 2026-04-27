"use client"

/**
 * DS-only theme toggle.
 *
 * Uses the same next-themes provider as the main app (mounted at the
 * root layout), so toggling here flips the global `dark` class on
 * <html>. That means: if you toggle in DS and navigate back to the
 * main app, the main app stays in whatever theme you left it in.
 *
 * Why we wrote our own instead of importing the main app's
 * <ThemeToggle>: that one force-locks light mode on mobile (the
 * main app doesn't support dark mode on phones). The DS app should
 * always allow toggling regardless of viewport.
 */

import { useTheme } from "next-themes"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

export function DsThemeToggle() {
  // useTheme is the next-themes hook — gives us the current theme name
  // ("light" | "dark" | "system") and a setter that updates <html class>.
  const { theme, setTheme } = useTheme()

  return (
    <Button
      variant="outline"
      size="icon"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label="Toggle dark mode"
    >
      {/* Show Sun in light, Moon in dark. Both rendered, swap visibility
          via Tailwind's `dark:` variant — keeps it CSS-only and avoids
          a render flicker. */}
      <Sun className="size-4 scale-100 dark:scale-0 transition-transform" />
      <Moon className="absolute size-4 scale-0 dark:scale-100 transition-transform" />
    </Button>
  )
}
