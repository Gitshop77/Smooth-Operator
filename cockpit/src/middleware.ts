// Next.js only auto-loads middleware from a file named `middleware.ts` with a
// `middleware` (or default) export — see next.config.ts (the auth gate it
// references). The real auth / rate-limit / per-request CSP logic lives in
// `proxy.ts`, which keeps its `@/proxy` exports so the unit tests
// (middleware.test.ts, auth-contract.test.ts) and the few routes that import
// helpers such as `tokensMatch` keep working unchanged.
//
// Re-exporting `proxy` as `middleware` here makes the token gate actually run
// at runtime instead of being dead code (it was previously unreachable because
// of the wrong filename / export name).
export { proxy as middleware, config } from "./proxy";
