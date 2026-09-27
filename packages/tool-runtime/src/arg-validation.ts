/**
 * Argument validation before execution (backlog Phase 28).
 *
 * A tool used to receive whatever JSON the model emitted and either misbehave or throw deep
 * inside its `execute`, so the failure surfaced as an opaque "Error: ..." the model could not
 * act on. This checks `call.args` against the tool's own declared `ToolParameterSchema` up
 * front and returns a *schema-correcting* message — the shape the tool wanted, not just that
 * it broke — which is the difference between a model retrying successfully and flailing.
 *
 * ## Why hand-rolled and not ajv
 *
 * The backlog suggested ajv. A full validator pulls a dependency into the lowest layer of the
 * tool stack to use maybe 15% of JSON Schema. The declared schemas here only ever use
 * `type` (object/array/string/number/boolean), `required`, `properties`, `items` and `enum`,
 * so a small strict-but-obvious checker covers them, stays deterministic, and cannot drift
 * from the schema the adapters already send to the provider. It deliberately does *not*
 * implement the rest of JSON Schema — that would be a false promise of coverage.
 *
 * It is intentionally permissive about things that are not the model's fault to get wrong:
 * unknown extra properties are allowed (models append context), and a numeric given as a
 * string for a `number` field is *accepted* here because providers do that and coercion is
 * harmless — tools that need a strict number (e.g. plan step ids) do that check themselves.
 */

import type { ToolParameterSchema } from "./index.js";

export interface ArgValidation {
  ok: boolean;
  /** Human/model-readable problems, phrased as the correction, not just the failure. */
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Mirrors the loose coercion providers do: `"3"` satisfies a `number` field. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
    case "boolean": return typeof value === "boolean" || value === "true" || value === "false";
    case "array": return Array.isArray(value);
    case "object": return typeOf(value) === "object";
    case "integer": return Number.isInteger(typeof value === "string" ? Number(value) : value);
    default: return true; // an unknown declared type is not this validator's problem
  }
}

function describe(value: unknown): string {
  const t = typeOf(value);
  if (t === "object") return `an object with keys ${JSON.stringify(Object.keys(value as object).slice(0, 8))}`;
  if (t === "array") return `an array of length ${(value as unknown[]).length}`;
  if (t === "string") return `the string ${JSON.stringify((value as string).slice(0, 40))}`;
  return `${t} ${JSON.stringify(value)}`;
}

function validateNode(schema: ToolParameterSchema, value: unknown, at: string, errors: string[]): void {
  if (schema.enum && !schema.enum.some((e) => e === value || String(e) === String(value))) {
    errors.push(`${at}: expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}, got ${describe(value)}.`);
    return;
  }
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${at}: expected ${schema.type}, got ${describe(value)}.`);
    return;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.items) {
      (value as unknown[]).forEach((el, i) => {
        if (el === undefined || el === null) errors.push(`${at}[${i}]: missing element.`);
        else validateNode(schema.items as ToolParameterSchema, el, `${at}[${i}]`, errors);
      });
    }
    return;
  }
  if (schema.type === "object" && value && typeof value === "object") {
    validateObject(schema, value as Record<string, unknown>, at, errors);
  }
}

function validateObject(schema: ToolParameterSchema, args: Record<string, unknown>, at: string, errors: string[]): void {
  for (const req of schema.required ?? []) {
    if (args[req] === undefined || args[req] === null || args[req] === "") {
      const declared = schema.properties?.[req];
      errors.push(`${at === "$" ? "argument" : `${at}.`}\`${req}\` is required${declared?.description ? ` (${declared.description})` : ""} but was missing or empty.`);
    }
  }
  if (!schema.properties) return;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const prop = schema.properties[key];
    if (!prop) continue; // unknown extras are the model adding context, not an error
    validateNode(prop, value, at === "$" ? `\`${key}\`` : `${at}.${key}`, errors);
  }
}

/** Validates a whole tool call's arguments against its declared parameter schema. */
export function validateToolArgs(schema: ToolParameterSchema | undefined, args: Record<string, unknown>): ArgValidation {
  if (!schema || schema.type !== "object") return { ok: true, errors: [] };
  const errors: string[] = [];
  validateObject(schema, args ?? {}, "$", errors);
  return { ok: errors.length === 0, errors };
}
