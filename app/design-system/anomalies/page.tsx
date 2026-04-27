/**
 * Anomalies page — places where the design system isn't being
 * followed.
 *
 * Each entry has a stable 4-character code (copyable on click) so
 * the user can reference one in conversation when asking me to fix
 * it. Status field flags whether the anomaly is open, intentional,
 * scheduled, or already fixed — not every anomaly is a bug.
 *
 * Anomalies are grouped by category so related issues land near
 * each other. The page is a flat scrolling list rather than a
 * filterable table because there are few entries (≈10) — a filter
 * UI would be more chrome than payload.
 */

import { CopyableCode } from "@/components/design-system/copyable-code"
import { PageHeader, Section } from "@/components/design-system/section"
import { cn } from "@/lib/utils"
import {
  type Anomaly,
  type AnomalyCategory,
  type AnomalyStatus,
  anomalies,
  categoryInfo,
  statusInfo,
} from "@/lib/design-system/anomalies"

// Map category → ordered list of anomalies. Keeps the JSX tidy.
function groupByCategory(): Map<AnomalyCategory, Anomaly[]> {
  const map = new Map<AnomalyCategory, Anomaly[]>()
  for (const a of anomalies) {
    const list = map.get(a.category) ?? []
    list.push(a)
    map.set(a.category, list)
  }
  return map
}

// Status pill — colour-coded so you can spot open issues at a glance.
function StatusPill({ status }: { status: AnomalyStatus }) {
  const info = statusInfo[status]
  const className = cn(
    "rounded-md px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider",
    {
      "bg-destructive/15 text-destructive": info.tone === "warn",
      "bg-primary/15 text-primary": info.tone === "good",
      "bg-accent/30 text-accent-foreground": info.tone === "info",
      "bg-muted text-muted-foreground": info.tone === "muted",
    },
  )
  return <span className={className}>{info.name}</span>
}

function AnomalyCard({ anomaly }: { anomaly: Anomaly }) {
  return (
    <article className="rounded-lg border border-border bg-card">
      {/* Header: code + title + status. Code is the most prominent
          element — it's the thing the user copies to reference this
          anomaly back to the assistant. */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <CopyableCode value={anomaly.id} />
        <h3 className="text-sm font-semibold">{anomaly.title}</h3>
        <div className="ml-auto flex items-center gap-2">
          {/* "Human-flagged" pill — only shown when the anomaly was
              caught by the designer/dev directly, not by an automated
              survey. Distinct visual style from the status pill so
              the source of the observation is obvious at a glance. */}
          {anomaly.flaggedBy === "human" && (
            <span className="rounded-md border border-accent/50 bg-accent/15 px-2 py-0.5 font-mono text-[0.6rem] uppercase tracking-wider text-accent-foreground">
              Human-flagged
            </span>
          )}
          <StatusPill status={anomaly.status} />
        </div>
      </header>

      <div className="space-y-3 p-4">
        <p className="text-sm text-foreground/90">{anomaly.description}</p>

        {/* Locations list. Monospace so file paths stay aligned;
            list-disc so multi-location anomalies read clearly. */}
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Locations</p>
          <ul className="list-inside list-disc space-y-0.5 font-mono text-xs text-foreground/70">
            {anomaly.locations.map((loc) => (
              <li key={loc}>{loc}</li>
            ))}
          </ul>
        </div>

        {anomaly.fix && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Suggested fix</p>
            <p className="text-xs text-foreground/80">{anomaly.fix}</p>
          </div>
        )}

        {anomaly.note && (
          // Yellow-ish note background to differentiate from the rest
          // of the body. Used for personal notes the user has added.
          <p className="rounded-md bg-muted px-3 py-2 text-xs italic text-muted-foreground">
            {anomaly.note}
          </p>
        )}
      </div>
    </article>
  )
}

export default function AnomaliesPage() {
  const grouped = groupByCategory()
  // Stable category ordering — colour is largest so it leads.
  const categoryOrder: AnomalyCategory[] = [
    "color",
    "typography",
    "structure",
    "iconography",
    "motion",
    "external",
  ]

  // Open count for the page header — gives the user an at-a-glance
  // sense of what's left to triage.
  const openCount = anomalies.filter((a) => a.status === "open").length

  return (
    <>
      <PageHeader
        title="Anomalies"
        subtitle={`${anomalies.length} entries (${openCount} open). Click an anomaly's code to copy it — codes are stable identifiers that survive reordering.`}
      />

      {/* Why "anomalies" not "deviations": some entries may turn out
          to be intentional. The status pill records that decision. */}
      <p className="mb-8 rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        Not every anomaly is a bug — the &quot;status&quot; pill tracks which way each
        one falls. <strong className="text-foreground/80">Open</strong> means it&apos;s
        flagged but unreviewed; <strong className="text-foreground/80">Intentional</strong>{" "}
        means it&apos;s confirmed deliberate; <strong className="text-foreground/80">Todo</strong>{" "}
        means a fix is planned; <strong className="text-foreground/80">Fixed</strong> means
        it&apos;s resolved but kept in the registry as a record so codes never get reused.
      </p>

      {categoryOrder.map((cat) => {
        const list = grouped.get(cat)
        if (!list || list.length === 0) return null
        const info = categoryInfo[cat]
        return (
          <Section
            key={cat}
            title={info.name}
            description={info.description}
          >
            <div className="flex flex-col gap-3">
              {list.map((a) => (
                <AnomalyCard key={a.id} anomaly={a} />
              ))}
            </div>
          </Section>
        )
      })}
    </>
  )
}
