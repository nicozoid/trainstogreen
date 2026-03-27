"use client"

import { X } from "lucide-react"
import { Input } from "@/components/ui/input"

type SearchBarProps = {
  value: string
  onChange: (value: string) => void
}

export default function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    // relative so the clear button can be positioned inside the input area
    <div className="relative">
      <Input
        type="text"
        placeholder="Search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // pr-8 reserves space on the right so text doesn't slide under the X button
        className="rounded-lg pr-8"
      />
      {/* Only render the button when there's something to clear */}
      {value && (
        <button
          onClick={() => onChange("")}
          // inset-y-0 + right-2 + my-auto centres the button vertically inside the input
          // p-1 enlarges the clickable area beyond the icon; cursor-pointer makes it obvious it's clickable
          className="absolute inset-y-0 right-1.5 my-auto flex items-center p-1 cursor-pointer text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}
