/**
 * Offline-tolerant queue for admin writes.
 *
 * Every admin mutation is enqueued here instead of calling fetch() directly.
 * The queue is mirrored to localStorage so a tab eviction (common on iOS
 * Safari when you lock the phone) doesn't lose the user's intent — the next
 * time the app loads while online, the drainer picks the queue up and
 * sends each item in order.
 *
 * Behavioural rules:
 *   - Drain is serial (one item at a time). Photo curations and walk PATCHes
 *     are order-sensitive (approve-then-move means something different
 *     after a tab reload than move-then-approve), so we don't parallelise.
 *   - Network errors keep the item as `pending` and stop the drain. The
 *     `online` window event restarts it. We never give up on a network
 *     error — connectivity always returns eventually.
 *   - 5xx server errors are transient — we retry the same item up to
 *     MAX_ATTEMPTS_BEFORE_FAILED before surfacing as `failed`.
 *   - 4xx errors are permanent (validation/missing/auth) — marked `failed`
 *     immediately. The user can dismiss or retry from the audit dialog.
 *   - Server-side conflict (409) handling is automatic via the route
 *     wrapper, so the client should rarely see a 409 here. If it does
 *     leak through, it's treated as 4xx (failed).
 */

export type OutboxItem = {
  id: string
  endpoint: string
  method: "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
  // Opaque lookup key for "is anything pending for X?". Callers build this
  // as "kind:identifier", e.g. "photo:51.4,-0.3:12345" or "walk:abc1".
  key: string
  // Human-readable label shown in the audit dialog and (for failed items)
  // any retry/dismiss surface. Keep it concise — fits on one line.
  label: string
  status: "pending" | "sending" | "failed"
  attempts: number
  enqueuedAt: number
  lastTriedAt?: number
  lastError?: string
}

export type ToastState = {
  kind: "saving" | "saved" | "error"
  message: string
  // Epoch ms — pill auto-clears once Date.now() > until.
  until: number
} | null

export type OutboxState = {
  items: OutboxItem[]
  online: boolean
  toast: ToastState
}

const STORAGE_KEY = "ttg.outbox.v1"
const TOAST_MS_SAVED = 2500
const TOAST_MS_ERROR = 5000
// 5xx retries before we give up and mark `failed`. Network errors don't
// count against this — they always retry on the next `online` event.
const MAX_ATTEMPTS_BEFORE_FAILED = 5

class Outbox {
  private items: OutboxItem[] = []
  private online = true
  private toast: ToastState = null
  private listeners = new Set<() => void>()
  private draining = false
  private toastTimeout: ReturnType<typeof setTimeout> | null = null
  private initialized = false
  // Cached snapshot for useSyncExternalStore. Must return the SAME object
  // reference when nothing's changed — otherwise React detects "the store
  // returned a different snapshot every render" and bails with the
  // "infinite loop" error. Rebuilt only when notify() is called.
  private cachedSnapshot: OutboxState = { items: [], online: true, toast: null }

  // Idempotent — called the first time a hook subscribes. We can't run
  // this in the constructor because module load happens during SSR, where
  // `window` is undefined and any `localStorage` access would explode.
  init = () => {
    if (this.initialized) return
    if (typeof window === "undefined") return
    this.initialized = true
    this.online = navigator.onLine
    this.load()
    window.addEventListener("online", this.handleOnline)
    window.addEventListener("offline", this.handleOffline)
    // Sync the cached snapshot now that we've populated `items` and
    // `online` from real sources, so the next read after init reflects
    // restored state from localStorage.
    this.notify()
    // Drain anything stuck from a previous session (e.g. tab evicted
    // during a save). Fire-and-forget — drain handles its own state.
    void this.drain()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): OutboxState => this.cachedSnapshot

  // Stable empty snapshot for SSR (`getServerSnapshot`). The hook reads
  // this on the server to avoid hydration mismatch warnings.
  getServerSnapshot = (): OutboxState => SSR_SNAPSHOT

  // Add a new item to the queue. Returns the assigned id so callers can
  // correlate optimistic UI to the queue entry if they need to.
  enqueue = (input: Omit<OutboxItem, "id" | "status" | "attempts" | "enqueuedAt">): string => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const full: OutboxItem = {
      ...input,
      id,
      status: "pending",
      attempts: 0,
      enqueuedAt: Date.now(),
    }
    this.items = [...this.items, full]
    this.persist()
    this.notify()
    void this.drain()
    return id
  }

  // Manual retry from the audit dialog — resets a failed item to pending.
  retry = (id: string) => {
    this.items = this.items.map((it) =>
      it.id === id ? { ...it, status: "pending", attempts: 0, lastError: undefined } : it,
    )
    this.persist()
    this.notify()
    void this.drain()
  }

  // Permanent dismissal — used when an item is hopelessly broken (bad
  // payload, removed walk, etc.) and the admin just wants it gone.
  dismiss = (id: string) => {
    this.items = this.items.filter((it) => it.id !== id)
    this.persist()
    this.notify()
  }

  private setToast = (next: ToastState) => {
    this.toast = next
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout)
      this.toastTimeout = null
    }
    if (next) {
      const remaining = next.until - Date.now()
      if (remaining > 0) {
        this.toastTimeout = setTimeout(() => {
          if (this.toast?.until === next.until) {
            this.toast = null
            this.notify()
          }
        }, remaining)
      }
    }
    this.notify()
  }

  private handleOnline = () => {
    this.online = true
    this.notify()
    void this.drain()
  }

  private handleOffline = () => {
    this.online = false
    this.notify()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    if (!this.online) return
    this.draining = true
    try {
      // Loop until we run out of pending items OR we go offline mid-drain.
      while (this.online) {
        const next = this.items.find((it) => it.status === "pending")
        if (!next) break
        await this.send(next)
      }
    } finally {
      this.draining = false
    }
  }

  private async send(item: OutboxItem): Promise<void> {
    this.items = this.items.map((it) =>
      it.id === item.id
        ? { ...it, status: "sending", attempts: it.attempts + 1, lastTriedAt: Date.now() }
        : it,
    )
    this.persist()
    this.notify()
    this.setToast({ kind: "saving", message: "Saving…", until: Date.now() + 60_000 })

    let res: Response
    try {
      res = await fetch(item.endpoint, {
        method: item.method,
        headers: item.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: item.body !== undefined ? JSON.stringify(item.body) : undefined,
      })
    } catch (e) {
      // Network failure — phone is offline OR the request was aborted by
      // iOS suspending the JS context. Keep as pending; the next online
      // event will retry. Don't toast — the offline banner conveys this.
      this.items = this.items.map((it) =>
        it.id === item.id ? { ...it, status: "pending", lastError: (e as Error).message } : it,
      )
      this.persist()
      // Re-check online state — `navigator.onLine` may have flipped.
      if (typeof navigator !== "undefined") this.online = navigator.onLine
      this.setToast(null)
      this.notify()
      return
    }

    if (res.ok) {
      this.items = this.items.filter((it) => it.id !== item.id)
      this.persist()
      this.notify()
      this.setToast({
        kind: "saved",
        message: `Saved · ${formatTime(new Date())}`,
        until: Date.now() + TOAST_MS_SAVED,
      })
      return
    }

    // Non-OK response. 4xx → permanent failure. 5xx → transient, retry.
    const errBody = await safeText(res)
    const errMsg = `${res.status} ${res.statusText}: ${errBody.slice(0, 200)}`
    const isClientError = res.status >= 400 && res.status < 500
    const exhaustedRetries = item.attempts >= MAX_ATTEMPTS_BEFORE_FAILED
    if (isClientError || exhaustedRetries) {
      this.items = this.items.map((it) =>
        it.id === item.id ? { ...it, status: "failed", lastError: errMsg } : it,
      )
      this.persist()
      this.setToast({
        kind: "error",
        message: "Save failed — try again",
        until: Date.now() + TOAST_MS_ERROR,
      })
      this.notify()
      return
    }
    // Transient 5xx. Leave as pending — next loop iteration will retry.
    this.items = this.items.map((it) =>
      it.id === item.id ? { ...it, status: "pending", lastError: errMsg } : it,
    )
    this.persist()
    this.setToast({
      kind: "error",
      message: "Save failed — will retry",
      until: Date.now() + TOAST_MS_ERROR,
    })
    this.notify()
  }

  private notify() {
    // Rebuild the cached snapshot ONCE per change so React's
    // useSyncExternalStore sees a stable reference between renders.
    this.cachedSnapshot = {
      items: this.items,
      online: this.online,
      toast: this.toast,
    }
    for (const fn of this.listeners) fn()
  }

  private persist() {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items))
    } catch {
      // Quota exceeded / Safari private browsing — non-fatal.
    }
  }

  private load() {
    if (typeof window === "undefined") return
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as OutboxItem[]
      // Any item that was `sending` when the tab died gets reset to
      // `pending` — we don't know if the request actually reached the
      // server. The server side is idempotent for our actions (set/unset/
      // toggle/append-if-absent), so a duplicate send is harmless.
      this.items = parsed.map((it) => ({
        ...it,
        status: it.status === "sending" ? "pending" : it.status,
      }))
    } catch {
      // Corrupted JSON — drop the queue rather than crash.
    }
  }
}

const SSR_SNAPSHOT: OutboxState = { items: [], online: true, toast: null }

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

// Single shared instance. Module-load-safe: the constructor doesn't touch
// window/navigator — `init()` does, and it's only called from useSyncEx-
// ternalStore inside the provider hook.
export const outbox = new Outbox()
