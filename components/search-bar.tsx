"use client"

import { Input } from "@/components/ui/input"

type SearchBarProps = {
  value: string
  onChange: (value: string) => void
}

export default function SearchBar({ value, onChange }: SearchBarProps) {
  return (
    <div>
      {/* type="search" gives the browser-native × clear button for free */}
      <Input
        type="search"
        placeholder="Search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg
        [&::-webkit-search-cancel-button]:cursor-pointer
        [&::-webkit-search-cancel-button]:opacity-50
[&::-webkit-search-cancel-button:hover]:opacity-100
"
      />
    </div>
  )
}
