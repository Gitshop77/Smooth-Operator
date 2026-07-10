/**
 * Config module barrel — re-exports the schema + validation helpers.
 */

export {
  AgentConfigSchema,
  ConfigValidationError,
  validateConfig,
} from "./schema";
export type {
  AgentConfigInput,
  AgentConfigValidated,
} from "./schema";
