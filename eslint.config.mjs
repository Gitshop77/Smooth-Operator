import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

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
  {
    files: ["**/*.ts"],
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
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
      "@typescript-eslint/no-floating-promises": ["warn", { ignoreIIFE: true }],
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", varsIgnorePattern: "^_", argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    rules: {
      ...sharedRules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", ".git/**"],
  },
];
