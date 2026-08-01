/**
 * Pure helper functions for normalizing JSON Schemas to OpenAI "strict" mode
 * requirements. Extracted from openai-chat.ts for maintainability.
 */

/**
 * Enforce OpenAI strict-mode requirements on an object schema: set
 * `additionalProperties: false` and ensure all properties are listed in
 * `required`.
 */
function enforceObjectStrictness(
  obj: Record<string, unknown>,
  props: Record<string, unknown>,
  existingRequired?: unknown,
): void {
  obj.additionalProperties = false;
  const required = Array.isArray(existingRequired) ? [...(existingRequired as string[])] : [];
  for (const key of Object.keys(props)) {
    if (!required.includes(key)) required.push(key);
  }
  obj.properties = props;
  obj.required = required;
}

/**
 * Rewrite a nullable schema node to strict-compliant `anyOf` union form.
 * Handles both `nullable: true` and `type: [..., "null"]` forms.
 */
function rewriteNullable(obj: Record<string, unknown>): Record<string, unknown> {
  const baseType = obj.type as string | string[] | undefined;
  let nonNullTypes: string[];
  if (Array.isArray(baseType)) nonNullTypes = baseType.filter((t) => t !== "null");
  else if (typeof baseType === "string") nonNullTypes = [baseType];
  else nonNullTypes = [];

  const branch: Record<string, unknown> = { ...obj };
  delete branch.nullable;
  delete branch.type;
  delete branch.properties;
  delete branch.additionalProperties;
  delete branch.required;

  const branchIsObject = nonNullTypes.includes("object") || nonNullTypes.length === 0;
  if (branchIsObject && obj.properties && typeof obj.properties === "object") {
    enforceObjectStrictness(branch, obj.properties as Record<string, unknown>, obj.required);
  }

  const result: Record<string, unknown> = { anyOf: [branch, { type: "null" }] };
  delete result.nullable;
  delete result.type;
  delete result.properties;
  delete result.additionalProperties;
  delete result.required;
  return result;
}

/**
 * Normalize a JSON Schema to OpenAI "strict" requirements so providers that
 * enforce `strict: true` don't reject it with a `400`.
 *
 * Recursion is depth-bounded to stay cheap on large schemas.
 */
export function normalizeStrictSchema(node: unknown, depth = 0): unknown {
  if (typeof node !== "object" || node === null) return node;
  const refObj = node as Record<string, unknown>;
  if (refObj.nullable === true && "$ref" in refObj) {
    return { anyOf: [{ $ref: refObj["$ref"] }, { type: "null" }] };
  }
  if ("$ref" in refObj) return node;
  const obj: Record<string, unknown> = { ...refObj };
  delete obj.default;

  const isNullable =
    obj.nullable === true || (Array.isArray(obj.type) && (obj.type as string[]).includes("null"));
  const isObjectNode =
    obj.type === "object" || (Array.isArray(obj.type) && (obj.type as string[]).includes("object"));

  if (isNullable) {
    const rewritten = rewriteNullable(obj);
    Object.assign(obj, rewritten);
    delete obj.nullable;
    delete obj.type;
    delete obj.properties;
    delete obj.additionalProperties;
    delete obj.required;
  } else if (isObjectNode && obj.properties && typeof obj.properties === "object") {
    enforceObjectStrictness(obj, obj.properties as Record<string, unknown>, obj.required);
  }

  if (depth >= 64) return obj;
  for (const key of ["items", "anyOf", "allOf", "oneOf", "not"]) {
    const child = obj[key];
    if (Array.isArray(child)) obj[key] = child.map((c) => normalizeStrictSchema(c, depth + 1));
    else if (child && typeof child === "object") obj[key] = normalizeStrictSchema(child, depth + 1);
  }
  for (const key of ["properties", "$defs"]) {
    const child = obj[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const dict = child as Record<string, unknown>;
      obj[key] = Object.fromEntries(
        Object.entries(dict).map(([k, v]) => [k, normalizeStrictSchema(v, depth + 1)]),
      );
    }
  }
  return obj;
}
