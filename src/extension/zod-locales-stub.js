// Stub for zod/v4/locales/index.js — only exports the "en" locale.
// Replaces zod's full locales barrel (50+ locale files, ~616 KB) at build
// time to keep the service worker bundle small. The MV3 service worker only
// ever uses the "en" locale at runtime, so the other locales are dead weight.
export { default as en } from "zod/v4/locales/en.js";
