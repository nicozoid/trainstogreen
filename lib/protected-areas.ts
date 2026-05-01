type ProtectedAreaInfo = {
  url: string
  /** Welsh/Scottish national_landscape areas keep the "AONB" label */
  country?: "wales" | "scotland"
}

export const PROTECTED_AREA_INFO: Record<string, ProtectedAreaInfo> = {
  "Brecon Beacons": { url: "https://beacons-npa.gov.uk/", country: "wales" },
  "Exmoor": { url: "https://www.exmoor-nationalpark.gov.uk/" },
  "Lake District": { url: "https://www.lakedistrict.gov.uk/" },
  "New Forest": { url: "https://www.newforestnpa.gov.uk/" },
  "North York Moors": { url: "https://www.northyorkmoors.org.uk/" },
  "Peak District": { url: "https://www.peakdistrict.gov.uk/" },
  "Pembrokeshire Coast": { url: "https://www.pembrokeshirecoast.wales/", country: "wales" },
  "Snowdonia": { url: "https://eryri.gov.wales/", country: "wales" },
  "South Downs": { url: "https://www.southdowns.gov.uk/" },
  "The Broads": { url: "https://www.broads-authority.gov.uk/" },
  "Yorkshire Dales": { url: "https://www.yorkshiredales.org.uk/" },
  "Arnside & Silverdale": { url: "https://www.arnside-silverdale.org.uk/" },
  "Chilterns": { url: "https://www.chilterns.org.uk/" },
  "Cotswolds": { url: "https://www.cotswolds-nl.org.uk/" },
  "Cranborne Chase & West Wiltshire Downs": { url: "https://cranbornechase.org.uk/" },
  "Dedham Vale": { url: "https://dedhamvale-nl.org.uk/" },
  "Dorset": { url: "https://dorset-nl.org.uk/" },
  "East Devon": { url: "https://eastdevon-nl.org.uk/" },
  "High Weald": { url: "https://highweald.org/" },
  "Isle Of Wight": { url: "https://isleofwight-nl.org.uk/" },
  "Kent Downs": { url: "https://kentdowns.org.uk/" },
  "Malvern Hills": { url: "https://www.malvernhills-nl.org.uk/" },
  "Norfolk Coast": { url: "https://norfolkcoast.org/" },
  "North Devon": { url: "https://www.northdevoncoast-nl.org.uk/" },
  "North Pennines": { url: "https://northpennines.org.uk/" },
  "North Wessex Downs": { url: "https://www.northwessexdowns.org.uk/" },
  "Shropshire Hills": { url: "https://www.shropshirehills-nl.org.uk/" },
  "South Devon": { url: "https://southdevon-nl.org.uk/" },
  "Surrey Hills": { url: "https://surreyhills.org/" },
  "Tamar Valley": { url: "https://www.tamarvalley-nl.org.uk/" },
}

/**
 * Returns the full display label for a protected area,
 * e.g. "New Forest National Park" or "High Weald National Landscape".
 * English AONBs → "National Landscape"; Welsh/Scottish → "AONB".
 */
export function protectedAreaLabel(
  name: string,
  type: string,
): string {
  if (type === "national_park") return `${name} National Park`
  const info = PROTECTED_AREA_INFO[name]
  if (info?.country === "wales" || info?.country === "scotland") {
    return `${name} AONB`
  }
  return `${name} National Landscape`
}
