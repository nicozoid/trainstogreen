// A drop-in replacement for React's useState that also persists the value to
// localStorage under the given key. On first mount we read the stored value
// (if any) and hydrate the state from it.
//
// Why we need the `hydrated` gate:
// Next.js renders the page server-side first, where `window` / `localStorage`
// don't exist. The initial client render must match the server render exactly
// (hydration), so we can't touch localStorage during the first render. Instead
// we start with `defaultValue`, then read the stored value inside useEffect
// (which only runs on the client after mount) and flip the state.
//
// The `serializer` argument lets callers store non-JSON-native values such as
// `Set`s — pass `{ toStorage, fromStorage }` to convert to/from a plain array.

import { useEffect, useState } from "react"

export type Serializer<T> = {
  toStorage: (value: T) => unknown
  fromStorage: (raw: unknown) => T
}

// Default serializer — works for strings, numbers, booleans, plain objects
// and arrays (anything JSON.stringify handles correctly).
const identitySerializer = <T,>(): Serializer<T> => ({
  toStorage: (value) => value,
  fromStorage: (raw) => raw as T,
})

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  serializer: Serializer<T> = identitySerializer<T>()
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // Start with the default value — this render runs on both server and client.
  const [value, setValue] = useState<T>(defaultValue)
  // Tracks whether we've finished reading from localStorage. This MUST be
  // state, not a ref: both effects below run in the same commit after the
  // first render. If we used a ref, mutating it in the hydration effect would
  // make the write-back effect see `hydrated=true` immediately and overwrite
  // the stored value with the still-default `value` from its closure.
  // As state, `hydrated` only becomes true in the NEXT commit — after the
  // hydration effect's setValue has taken effect — so the write-back is
  // safe to run.
  const [hydrated, setHydrated] = useState(false)

  // One-shot hydration from localStorage, client-only (useEffect doesn't run
  // on the server).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        setValue(serializer.fromStorage(parsed))
      }
    } catch {
      // Ignore corrupt storage — fall back to default. Could be JSON parse
      // error, storage full, or disabled (e.g. private browsing).
    }
    setHydrated(true)
    // We only want this to run once on mount — key/serializer are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Write-back on every value change, but not during hydration.
  useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify(serializer.toStorage(value))
      )
    } catch {
      // Storage may be full or disabled — swallow and continue.
    }
  }, [key, value, serializer, hydrated])

  return [value, setValue]
}

// Ready-made serializer for a Set<string> — localStorage only holds strings,
// and JSON doesn't know how to stringify Sets, so we convert to/from Array.
export const setSerializer: Serializer<Set<string>> = {
  toStorage: (value) => Array.from(value),
  fromStorage: (raw) => new Set(raw as string[]),
}
