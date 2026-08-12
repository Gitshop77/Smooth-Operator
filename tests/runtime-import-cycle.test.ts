import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true;
  return !!clause.namedBindings?.elements.some((element) => !element.isTypeOnly);
}

function runtimeSpecifiers(source: string, fileName = "fixture.ts"): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        importClauseHasRuntimeValue(node.importClause)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
        !node.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function resolveSourceImport(
  fromFile: string,
  specifier: string,
  srcRoot: string,
  files: Set<string>,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  const unresolved = specifier.startsWith("@/")
    ? path.join(srcRoot, specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  const withoutJs = unresolved.replace(/\.(?:mjs|cjs|js)$/, "");
  for (const candidate of [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    path.join(unresolved, "index.ts"),
    path.join(unresolved, "index.tsx"),
  ]) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function runtimeGraph(srcRoot: string): Map<string, string[]> {
  const files = sourceFiles(srcRoot);
  const fileSet = new Set(files);
  return new Map(files.map((file) => [
    file,
    [...new Set(runtimeSpecifiers(readFileSync(file, "utf8"), file)
      .map((specifier) => resolveSourceImport(file, specifier, srcRoot, fileSet))
      .filter((resolved): resolved is string => resolved !== null && resolved !== file))].sort(),
  ]));
}

function findRuntimeCycles(graph: Map<string, string[]>): string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles = new Set<string>();

  const visit = (file: string): void => {
    if (active.has(file)) {
      const start = stack.indexOf(file);
      const cycle = stack.slice(start);
      const rotations = cycle.map((_, index) =>
        [...cycle.slice(index), ...cycle.slice(0, index)]);
      rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")));
      cycles.add(rotations[0].join(" -> "));
      return;
    }
    if (visited.has(file)) return;
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    active.delete(file);
    visited.add(file);
  };

  for (const file of graph.keys()) visit(file);
  return [...cycles].sort().map((cycle) => cycle.split(" -> "));
}

describe("runtime import graph", () => {
  test("extracts value static/re-export and literal dynamic imports only", () => {
    expect(runtimeSpecifiers(`
      import type { A } from "./type-only";
      import { type B } from "./also-type-only";
      import { type C, value } from "./mixed";
      import "./side-effect";
      export type { D } from "./export-type";
      export { value as other } from "./export-value";
      void import("./literal-dynamic");
      void import("./" + name);
    `)).toEqual([
      "./mixed",
      "./side-effect",
      "./export-value",
      "./literal-dynamic",
    ]);
  });

  test("production source has no runtime import cycle", () => {
    const srcRoot = path.join(process.cwd(), "src");
    const relative = findRuntimeCycles(runtimeGraph(srcRoot)).map((cycle) =>
      cycle.map((file) => path.relative(process.cwd(), file)));
    expect(relative).toEqual([]);
  });
});
