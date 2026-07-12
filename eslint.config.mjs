/**
 * ESLint config — minimal, no framework dependency.
 *
 * NOTE: this repo does NOT currently have a working `tsc --noEmit` type-safety
 * gate. package.json defines no `tsc`/`typecheck` script, and tsconfig.json
 * restricts `compilerOptions.types` to `["chrome"]` (excluding `@types/node`),
 * so a `tsc --noEmit` run would error on the Node-based build/config scripts
 * (`esbuild.config.ts`, `vitest.config.ts`, etc.) that import `path`/`fs`/
 * `__dirname`/`process`. Until that is fixed (add a `typecheck` script and a
 * `tsconfig.node.json` for the Node scripts), ESLint is the only automated
 * static check that actually runs. It is kept for the runtime correctness
 * rules that tsc would not cover even once enabled: unused variables,
 * prefer-const, no-fallthrough, and no-dupe-keys.
 *
 * `.ts` files use the `@typescript-eslint/parser` + `@typescript-eslint/no-unused-vars`
 * rule. Without the parser, ESLint v9+ flat config only lints `.js`/`.mjs`
 * files — `.ts` files were silently skipped, making `npm run lint` a no-op
 * for the entire extension + agent library. The TS-aware `no-unused-vars`
 * avoids the core rule's false-positives on enum members, generic params,
 * and `declare global` augmentations.
 */
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// Rules shared by all linted files (.ts and .js/.mjs).
const sharedRules = {
  "no-unreachable": "error",
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-useless-escape": "warn",
  "no-console": "off",
  "no-debugger": "error",
  "no-empty": "warn",
  "no-irregular-whitespace": "error",
  "no-case-declarations": "error",
  "no-fallthrough": "error",
  "no-mixed-spaces-and-tabs": "error",
  "prefer-const": "error",
};

export default [
  // .ts / .tsx files: TS parser + TS-aware no-unused-vars. The glob also
  // matches `.tsx` so JSX in extension/agent `.tsx` files is parsed by the
  // TypeScript parser rather than falling through to espree (which cannot
  // parse TS/JSX and would make `npm run lint` fail with parse errors).
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...sharedRules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        // `args: "none"` — do not flag unused function parameters. In a TS
        // codebase, params are frequently interface/callback conformances.
        // tsc's `noUnusedParameters` covers genuinely-unused params if the
        // project opts in; ESLint here focuses on unused vars/imports.
        { "args": "none", "varsIgnorePattern": "^_", "ignoreRestSiblings": true },
      ],
    },
  },
  // .js/.mjs files: core no-unused-vars (TS rule doesn't apply to JS).
  {
    files: ["**/*.js", "**/*.mjs"],
    rules: {
      ...sharedRules,
      "no-unused-vars": [
        "warn",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "chrome-extension/**",
      "cockpit/**",
      "mini-services/**",
    ],
  },
];
