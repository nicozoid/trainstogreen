"use client"

/**
 * React bindings for the admin outbox.
 *
 * The provider calls `outbox.init()` once on mount (which wires up the
 * online/offline listeners and drains anything left over from a previous
 * session) and exposes hooks that subscribe to the singleton's state via
 * useSyncExternalStore — the standard React 18 pattern for binding to an
 * external mutable store.
 *
 * Hooks:
 *   useAdmin()             — full snapshot + action methods
 *   usePending(key)        — boolean, "is anything pending for this key?"
 *   usePendingCount()      — number of items still in the queue
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from "react"
import { outbox, type OutboxItem, type OutboxState } from "@/lib/admin-outbox"

type AdminContextValue = {
  state: OutboxState
  enqueue: typeof outbox.enqueue
  retry: typeof outbox.retry
  dismiss: typeof outbox.dismiss
}

const AdminContext = createContext<AdminContextValue | null>(null)

export function AdminProvider({ children }: { children: React.ReactNode }) {
  // Initialise the outbox once on mount. Idempotent — repeated calls are
  // a no-op, so dev-mode StrictMode double-invoke is fine.
  useEffect(() => {
    outbox.init()
  }, [])

  const state = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getServerSnapshot)

  const value: AdminContextValue = {
    state,
    enqueue: outbox.enqueue,
    retry: outbox.retry,
    dismiss: outbox.dismiss,
  }

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext)
  if (!ctx) {
    throw new Error("useAdmin must be used within <AdminProvider>")
  }
  return ctx
}

// Returns true if there's at least one queue item with a matching key
// that hasn't been sent successfully yet (pending OR sending OR failed).
// Components use this to render a "saving / not yet synced" badge on
// the affected entity.
export function usePending(key: string): boolean {
  const { state } = useAdmin()
  return state.items.some((it) => it.key === key)
}

// Returns the failed items only — the audit dialog highlights these
// so the admin can retry/dismiss without scrolling past everything.
export function useFailedItems(): OutboxItem[] {
  const { state } = useAdmin()
  return state.items.filter((it) => it.status === "failed")
}

export function usePendingCount(): number {
  const { state } = useAdmin()
  return state.items.length
}
