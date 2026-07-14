import * as React from "react"

// Rewritten with `useSyncExternalStore` — the previous
// `useEffect + setIsMobile` pattern triggered the
// `react-hooks/set-state-in-effect` warning because the effect body
// synchronously called setState on mount (cascading render). The
// `useSyncExternalStore` API is the React-recommended pattern for
// subscribing to external stores (here: the browser's matchMedia) and
// reads the current value lazily on every render without an effect.
const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

// Lazily memoize a single MediaQueryList so we don't re-allocate one on every
// render or per subscription. The getter is deferred to call time so the module
// stays SSR-safe (no `window` access during import on the server).
let mql: MediaQueryList | null = null
function getMql(): MediaQueryList {
  if (!mql) mql = window.matchMedia(MOBILE_QUERY)
  return mql
}

function subscribe(callback: () => void) {
  const list = getMql()
  list.addEventListener("change", callback)
  return () => list.removeEventListener("change", callback)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => getMql().matches,
    () => false, // server snapshot — assume desktop during SSR
  )
}
