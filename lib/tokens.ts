// Reads CSS custom properties at runtime so Mapbox (WebGL canvas)
// can use the same colours defined in globals.css.
// Mapbox doesn't understand oklch, so we set the colour on a temporary
// element and read back the browser-computed rgb value.

function resolveVar(varName: string): string {
  const el = document.createElement("div")
  el.style.color = `var(${varName})`
  document.body.appendChild(el)
  const rgb = getComputedStyle(el).color
  document.body.removeChild(el)
  return rgb
}

export function getColors() {
  return {
    primary: resolveVar("--primary"),
    secondary: resolveVar("--secondary"),
  }
}
