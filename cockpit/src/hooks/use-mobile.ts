import * as React from "react"

// Rewritten with `useSyncExternalStore` — the previous
// `useEffect + setIsMobile` pattern triggered the
// `react-hooks/set-state-in-effect` warning because the effect body
// synchronously called setState on mount (cascading render). The
// `useSyncExternalStore` API is the React-recommended pattern for
// subscribing to external stores (here: the browser's matchMedia) and
// reads the current value lazily on every render without an effect.
const MOBILE_BREAKPOINT = 768

function subscribe(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false, // server snapshot — assume desktop during SSR
  )
}
