"use client"

import { Input } from "@/components/ui/input"

type SearchBarProps = {
  value: string
  onChange: (value: string) => void
}

/**
 * Thin wrapper around Input with a fixed "Search stations" placeholder and
 * rounded corners matching the filter-panel's card style. The clear (X)
 * button is now provided automatically by Input itself — SearchBar no
 * longer needs its own wrapper div or X-button.
 */
export default function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <Input
      type="text"
      placeholder="Search stations"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg"
    />
  )
}
