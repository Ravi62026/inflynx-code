/**
 * Phase 38 — tool-contract coverage (the suite the plan referenced but never existed)
 *
 * Every registered tool must have a well-formed schema and its arguments must be validated.
 * A drift guard: a tool added later with a `parameters: {}` that actually takes args, a
 * description the model cannot act on, or a `required` naming a property that does not exist,
 * fails here rather than shipping a tool the model mis-calls and blames its reasoning for.
 *
 * Checks per the "Done when":
 *   1. schema validity  — snake_case name, real description, object params, required ⊆ properties,
 *      every declared property carries a type.
 *   2. non-empty where it takes args — argument tools are not silently argless.
 *   3. the shared validator (the one the gateway uses) rejects a missing-required call for EVERY
 *      required-arg tool, and enforces type/required on a known schema (three-sided).
 */
import { strict as assert } from "node:assert";
import { CORE_TOOLS } from "../../packages/tool-runtime/src/index.js";
import { validateToolArgs } from "../../packages/tool-runtime/src/arg-validation.js";

console.log("=== Phase 38: tool-contract coverage ===");

const tools = CORE_TOOLS;
assert.ok(Array.isArray(tools) && tools.length >= 15, `expected the real tool surface, got ${tools?.length}`);

// 1 --- schema validity across the whole registry.
{
  const failures: string[] = [];
  for (const t of tools) {
    if (!/^[a-z][a-z0-9_]*$/.test(t.name)) failures.push(`${t.name}: name not snake_case`);
    if (!t.description || t.description.trim().length < 20) failures.push(`${t.name}: description too thin`);
    if (!t.parameters || t.parameters.type !== "object") failures.push(`${t.name}: parameters must be {type:"object"}`);
    const props = (t.parameters.properties || {}) as Record<string, any>;
    for (const req of t.parameters.required || []) {
      if (!(req in props)) failures.push(`${t.name}: required "${req}" not in properties`);
    }
    for (const [pname, schema] of Object.entries(props)) {
      if (!schema || !schema.type) failures.push(`${t.name}.${pname}: property has no "type"`);
    }
  }
  assert.deepEqual(failures, [], `schema validity:\n  ${failures.join("\n  ")}`);
  console.log(`  ✓ ${tools.length} tools: well-formed schemas`);
}

// 2 --- argument-taking tools are NOT silently argless; shell_list legitimately is.
{
  const mustTakeArgs = ["read_file", "write_file", "patch_file", "search_files", "execute_shell", "list_diagnostics", "update_plan"];
  for (const name of mustTakeArgs) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} must be registered`);
    assert.ok(Object.keys(t!.parameters.properties || {}).length > 0, `${name}: empty schema but takes arguments`);
  }
  assert.ok(tools.some((t) => Object.keys(t.parameters.properties || {}).length === 0),
    "expected ≥1 legitimately argless tool so the allowance is exercised, not blanket");
  console.log("  ✓ argument tools have real schemas; the argless allowance is exercised");
}

// 3 --- every required-arg tool rejects an empty call via the shared validator.
{
  let validated = 0;
  for (const t of tools) {
    const req = t.parameters.required || [];
    if (req.length === 0) continue;
    const res = validateToolArgs(t.parameters, {});
    assert.equal(res.ok, false, `${t.name}: empty args passed validation despite required [${req.join(",")}]`);
    assert.ok(res.errors.some((e) => req.some((r) => e.includes(r))),
      `${t.name}: validator errors do not name the missing required args: ${JSON.stringify(res.errors)}`);
    validated++;
  }
  assert.ok(validated >= 8, `expected ≥8 required-arg tools validated, got ${validated}`);
  console.log(`  ✓ ${validated} required-arg tools reject an empty call (shared validator)`);
}

// 4 --- the validator enforces type as well as presence (three-sided, not just "missing").
{
  const schema = { type: "object", properties: { path: { type: "string" }, count: { type: "number" } }, required: ["path"] } as any;
  assert.equal(validateToolArgs(schema, {}).ok, false, "missing required must fail");
  assert.equal(validateToolArgs(schema, { path: 42 }).ok, false, "wrong type must fail (not just missing)");
  assert.equal(validateToolArgs(schema, { path: "src/a.ts", count: 3 }).ok, true, "a well-typed call must pass");
  console.log("  ✓ validator catches missing AND mistyped arguments, passes valid ones");
}

console.log("\n=== Phase 38 results:", 0, "failures ===");
process.exit(0);
