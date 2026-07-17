"use client";

import * as React from "react";

export function OfflineBanner({ className }: { className?: string }) {
  const [online, setOnline] = React.useState(true);

  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      className={`w-full px-4 py-2 text-center text-sm bg-destructive/15 text-destructive border-b border-destructive/30 ${className ?? ""}`}
    >
      You are offline. Live relay data and token validation are paused until
      your connection returns.
    </div>
  );
}
