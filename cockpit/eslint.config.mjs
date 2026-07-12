import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
 // General JavaScript rules — keep the rules that catch real bugs.
    "prefer-const": "error",
    "no-unused-vars": "off", // handled by @typescript-eslint/no-unused-vars below
    "no-console": "off",
    "no-debugger": "error",
    "no-empty": "warn",
    "no-irregular-whitespace": "error",
    "no-case-declarations": "error",
    "no-fallthrough": "error",
    "no-mixed-spaces-and-tabs": "error",
    "no-redeclare": "off", // handled by @typescript-eslint
    "no-undef": "off", // handled by tsc
    "no-unreachable": "error",
    "no-useless-escape": "warn",
    "no-dupe-keys": "error",

 // TypeScript rules — keep the high-signal ones as warnings so they
 // surface real issues without blocking the build on style nits.
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
    ],
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-non-null-assertion": "warn",
    "@typescript-eslint/ban-ts-comment": "warn",

 // React rules — keep exhaustive-deps (catches stale-closure bugs).
    "react-hooks/exhaustive-deps": "warn",
    "react-hooks/set-state-in-effect": "warn",
    "react-hooks/purity": "warn",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"],
}];

export default eslintConfig;
