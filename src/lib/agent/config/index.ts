/**
 * Config module barrel — re-exports the validation helper used by the
 * orchestrator. The schema and its input/output types are defined in
 * `./schema` and deliberately not re-exported here: `AgentConfigSchema`,
 * `ConfigValidationError`, `AgentConfigInput`, and `AgentConfigValidated` have
 * no consumers outside `schema.ts`, so widening the barrel API surface for them
 * only adds maintenance cost. Import them directly from `./schema` if needed.
 */

export { validateConfig } from "./schema";
