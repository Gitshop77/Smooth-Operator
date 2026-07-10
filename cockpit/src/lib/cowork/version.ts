//
// Cockpit version — single source of truth shared by the server-side discovery
// routes (`/api/cowork/agent/*`, `/api/cowork/skill`) and the client-side
// footer. Keep this file dependency-free so it is safe to import from both
// server and client components without pulling server-only modules into the
// browser bundle.
//
// Bump this together with the CHANGELOG when cutting a release.

export const COCKPIT_VERSION = "0.3.1";
