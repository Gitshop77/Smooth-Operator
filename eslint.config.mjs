/**
 * ESLint config — minimal, no framework dependency.
 *
 * NOTE: type-safety is provided by `npx tsc --noEmit`, which CI runs directly
 * (see `.github/workflows/ci.yml` — the `Type-check root TypeScript` step).
 * It uses the root tsconfig.json, which includes .ts / .tsx through the **
 * glob and excludes the gitignored `chrome-extension` build output (a plain
 * copy of the sources tsc already checked here). The `compilerOptions.types:
 * ["chrome"]` setting does NOT
 * break this: explicitly-imported Node modules (`path`, `fs`, `process`) still
 * resolve through `@types/node`, which is present in node_modules, so
 * `npx tsc --noEmit` exits 0 (clean). package.json defines no
 * `tsc`/`typecheck` *script* — CI invokes `tsc` directly — so there is no
 * `npm run typecheck`, but the type-check gate itself is real and passing.
 * ESLint remains the automated static check for the runtime-correctness rules
 * that tsc does not cover: unused variables, prefer-const, no-fallthrough,
 * no-dupe-keys, and others configured below.
 *
 * `.ts` files use the `@typescript-eslint/parser` +
 * `@typescript-eslint/no-unused-vars` rule. Without the parser, ESLint v9+
 * flat config only lints `.js`/`.mjs` files — `.ts` files were silently
 * skipped, making `npm run lint` a no-op for the entire extension + agent
 * library. The TS-aware `no-unused-vars` avoids the core rule's
 * false-positives on enum members, generic params, and `declare global`
 * augmentations.
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
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...sharedRules,
      // Use the TypeScript-aware `no-redeclare` for `.ts` files: the base ESLint
      // rule does not understand TS function overloads (multiple `export function
      // foo()` declarations) and false-positives on them. The TS rule treats
      // overloads as a single declaration and only flags genuine redeclarations
      // (tsc would also catch those, so this stays defense-in-depth).
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
      "@typescript-eslint/no-floating-promises": ["warn", { "ignoreIIFE": true }],
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
      "coverage/**",
      ".audit/**",
      "chrome-extension/**",
    ],
  },
];
