/**
 * Fake-fix detection (backlog Phase 32).
 *
 * Phase 31 wired the verification gate into the loop, which created a new way to cheat:
 * the model can satisfy a failing gate without fixing the defect — silence the compiler,
 * disable the linter, skip or delete the test, assert `true`. Every one of those makes
 * "green" mean less, and the gate's whole value is that green means something. So this is
 * not polish; it is what keeps Phase 31 honest.
 *
 * Why this lives here: `RepairLoop` sits in agent-core, and tool-runtime cannot import
 * agent-core (agent-core imports tool-runtime). A check that must run on the *enforcement*
 * path belongs in the package both sides already depend on.
 *
 * ## The rule every detector follows: additions only
 *
 * A directive that is already in the file stays in the file. Only a pattern that appears
 * in the replacement and not in the original counts, which is what makes this usable on
 * ordinary code — otherwise the first edit to a file containing `eslint-disable` would be
 * blocked forever, and the fix for a false positive would be to turn the control off.
 */

/** A named rule, so a refusal can be quoted back exactly and a test can pin it. */
export type PatchSafetyRule =
  | "suppress-directive"
  | "linter-disable"
  | "empty-handler"
  | "test-skipped"
  | "test-isolated"
  | "trivial-assertion"
  | "assertion-removed"
  | "assertion-commented-out"
  | "test-block-removed"
  | "test-file-deleted"
  | "forced-exit-in-test"
  | "secret-introduced";

export interface PatchSafetyViolation {
  rule: PatchSafetyRule;
  reason: string;
  /** The offending text, trimmed, so the human can see *which* line. */
  evidence: string;
}

export interface PatchSafetyReview {
  safe: boolean;
  violations: PatchSafetyViolation[];
  /** Test-ish path or content, used to decide the file-level test-count rules. */
  touchesTests: boolean;
}

/**
 * Suppression directives, per language. Group 1 is the directive itself; it is quoted back
 * as evidence.
 */
const SUPPRESS_DIRECTIVES: Array<{ re: RegExp; rule: PatchSafetyRule; label: string }> = [
  { re: /\/\/\s*@ts-(?:ignore|expect-error|nocheck)\b[^*\n]*/g, rule: "suppress-directive", label: "a TypeScript error suppression" },
  { re: /\/\*\s*@ts-(?:ignore|expect-error|nocheck)[\s\S]{0,80}?\*\//g, rule: "suppress-directive", label: "a TypeScript error suppression" },
  { re: /#\s*type:\s*ignore(?![^#\n]*strict)/g, rule: "suppress-directive", label: "a Python type-error suppression" },
  { re: /#\s*noqa(?![^#\n]*type:ignore)/g, rule: "suppress-directive", label: "a Python linter suppression" },
  { re: /\/\/\s*nolint\b/g, rule: "suppress-directive", label: "a Go linter suppression" },
  { re: /\/\/\s*NOLINT(?:NEXTLINE)?\b/g, rule: "suppress-directive", label: "a C++ linter suppression" },
  { re: /(?:\/\/|\/\*)\s*eslint-disable[^\n]*?(?:\*\/|$)/g, rule: "linter-disable", label: "an ESLint disable directive" },
  { re: /\/\/\s*biome-ignore[^\n]*/g, rule: "linter-disable", label: "a Biome disable directive" },
  { re: /@SuppressWarnings\s*\(\s*(?:\{[^}]*\}|"[A-Za-z]")/g, rule: "suppress-directive", label: "a Java warning suppression" },
  { re: /#pragma\s+(?:warning|diagnostic)\s+(?:ignore|push)/g, rule: "suppress-directive", label: "a C/C++ diagnostic suppression" },
];

/** Handlers that swallow rather than handle. */
const EMPTY_HANDLERS: RegExp[] = [
  /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
  /try\s*\{[^{}]{0,400}?\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
  /\.catch\s*\(\s*(?:\(\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/g,
  /except[^:\n]*:\s*\n\s*pass\b/g,
  /except[^:\n]*:\s*pass\b/g,
  /}\s*catch\s*\([^)]*\)\s*\{\s*\}/g,
];

const TEST_SKIP: RegExp[] = [
  /(?:^|[^.\w])(?:it|test|describe)\.skip(?:\.if\([^)]*\))?\s*\(/g,
  /\bt\.Skip\s*\(/g,
  /\bb\.Skip(?:Now|Test)?\s*\(/g,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /@Test\s*\(\s*enabled\s*=\s*false\s*\)/g,
  /\b\[skip\]|\bxtest\b|\bxit\s*\(/g,
];

/** An assertion turned into a comment: the same line, no longer checked. */
const COMMENTED_OUT_TESTS: RegExp[] = [
  /^\s*#[^#\n]*\b(?:it|test|assert|expect|def test)\b.*\)?\s*$/gm,
  /^\s*\/\/[^/\n]*\b(?:it|test|expect|assert)\s*\(.*\)\s*;?\s*$/gm,
  /^\s*(?:\/\*|\*)[^*\n]*\b(?:it|test|expect|assert)\s*\(.*$/gm,
];

/** Focusing a test run silently narrows what "green" covered. */
const TEST_ISOLATE: RegExp[] = [
  /(?:^|[^.\w])(?:it|test|describe)\.only\s*\(/g,
  /\bb\.Run(?:Parallel)?\(\s*"[^"]*",\s*func[^)]*\{\s*t\.Parallel\(\)/g,
];

/** Assertions that can never fail, added to satisfy a gate that wanted a real check. */
const TRIVIAL_ASSERTIONS: RegExp[] = [
  /expect\s*\(\s*true\s*\)\s*\.\s*toBe(?:Truthy)?\s*\(/g,
  /expect\s*\(\s*(\d+|"[^"]*"|'[^']*')\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/g,
  /assert\s*\(\s*(?:true|1|Boolean\(\s*1\s*\))\s*\)/g,
  /\bASSERT\s+TRUE\b/gi,
  /self\.assertTrue\s*\(\s*True\s*\)/g,
  /expect\s*\(\s*expect\.any\(\)\s*\)/g,
  /\bassert\.ok\s*\(\s*(?:true|1)\s*\)/g,
];

/** Test-block declarations, for counting what a patch removed from a test file. */
const TEST_BLOCKS = /(?:^|[^.\w])(?:it|test|describe)\s*\(\s*["'`]|func\s+Test[A-Z]|(?:def|function|async\s+function|async\s+def)\s+test[A-Za-z_0-9]*|@Test\b|(?:it|spec)\s*\(\s*["'`]/g;

const ASSERTION_CALLS = /(?:^|[^.\w])(?:expect|assert|assertEquals|assertTrue|assertThat|require|should|check)\s*\(/g;

/** Forcing a zero exit inside a test file makes the suite pass by leaving early. */
const FORCED_EXIT: RegExp[] = [
  /process\.exit\s*\(\s*0\s*\)/g,
  /\bsys\.exit\s*\(\s*0\s*\)/g,
  /\bexit\(0\)/g,
  /os\.Exit\s*\(\s*0\s*\)/g,
];

/** Credential-shaped literals introduced by the patch itself. */
const SECRET_SHAPED: RegExp[] = [
  /\b(?:sk|ghp|github_pat|glpat|xox[abpsr]|AIza|ya29\.)[A-Za-z0-9_\-]{16,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

const TEST_PATH = /(^|\/)(?:tests?|__tests__|spec|e2e|integration)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb|rs)$|^test_[^/]*\.py$|Test\.(?:java|kt|cs)$/i;

/**
 * Documentation and lockfiles *describe* code rather than being code. A docs page
 * explaining `@ts-ignore` is not a patch suppressing a type error, and flagging it would
 * make this feature unusable — so directive-shaped text in those files is not a violation.
 * Introducing a credential is still one: a secret pasted into a README is a real leak.
 */
const DESCRIPTIVE_PATH = /\.(?:md|mdx|rst|adoc|txt|jsonc?|ya?ml|toml|lock)$/i;

function matchesAdded(patterns: RegExp[], before: string, after: string): RegExpMatchArray | null {
  for (const re of patterns) {
    const afterHits = after.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
    if (!afterHits) continue;
    const beforeHits = before.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || [];
    // New occurrences only: an existing directive in untouched code is not this patch's
    // doing, and blocking on it would make the file permanently uneditable.
    if (afterHits.length > beforeHits.length) return [afterHits[afterHits.length - 1]];
  }
  return null;
}

export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}

/**
 * Reviews what a proposed replacement introduces. Pure: reads nothing, writes nothing,
 * and never mutates. Callers on the enforcement path decide whether a violation is a
 * refusal or an override prompt.
 */
export function reviewPatchSafety(input: {
  filePath?: string;
  before: string;
  after: string;
  /** True when the operation removes the file entirely. */
  deletesFile?: boolean;
}): PatchSafetyReview {
  const { filePath = "", before = "", after = "", deletesFile = false } = input;
  const violations: PatchSafetyViolation[] = [];
  const touchesTests = isTestPath(filePath) || /\b(?:describe|it|test|expect|assert)\s*\(/.test(before + after);
  // Docs describe code; they are not patches to it.
  const descriptive = DESCRIPTIVE_PATH.test(filePath);

  const push = (rule: PatchSafetyRule, reason: string, evidence: string) =>
    violations.push({ rule, reason, evidence: evidence.trim().slice(0, 160) });

  for (const { re, rule, label } of SUPPRESS_DIRECTIVES) {
    if (descriptive) break;
    const hit = matchesAdded([re], before, after);
    if (hit) {
      push(rule, `this patch adds ${label} (${rule === "linter-disable" ? "linter" : "type"} suppression). The diagnostic it hides is the defect — fix the code, not the message.`, hit[0]);
    }
  }

  const empty = matchesAdded(EMPTY_HANDLERS, before, after);
  if (empty && !descriptive) push("empty-handler", "this patch adds an empty handler that swallows an error silently. Handle it, rethrow, or let it propagate.", empty[0]);

  const skipped = matchesAdded(TEST_SKIP, before, after);
  if (skipped && !descriptive) push("test-skipped", "this patch skips a test. A skipped test is a defect with a green build — fix it or explain it in the response, do not hide it.", skipped[0]);

  const isolated = matchesAdded(TEST_ISOLATE, before, after);
  if (isolated && !descriptive) push("test-isolated", "this patch focuses/isolates a test run, so only a subset is verified while the result reads as a pass.", isolated[0]);

  const trivial = matchesAdded(TRIVIAL_ASSERTIONS, before, after);
  if (trivial && !descriptive) push("trivial-assertion", "this patch adds an assertion that cannot fail. Assert something that would actually break.", trivial[0]);

  const exits = matchesAdded(FORCED_EXIT, before, after);
  if (exits && touchesTests && !descriptive) push("forced-exit-in-test", "this patch exits with status 0 inside a test file, which ends the run instead of passing it.", exits[0]);

  const commented = matchesAdded(COMMENTED_OUT_TESTS, before, after);
  if (commented && !descriptive) push("assertion-commented-out", "this patch comments out a test or assertion instead of fixing it.", commented[0]);

  const secrets = matchesAdded(SECRET_SHAPED, before, after);
  if (secrets) push("secret-introduced", "this patch introduces what looks like a real credential. Move it to an environment variable or the keychain; it must not be committed.", secrets[0].slice(0, 24) + "…");

  // Counting rules only make sense when the patch is shrinking something.
  const beforeAsserts = (before.match(new RegExp(ASSERTION_CALLS.source, "g")) || []).length;
  const afterAsserts = (after.match(new RegExp(ASSERTION_CALLS.source, "g")) || []).length;
  if (beforeAsserts > 0 && afterAsserts < beforeAsserts && !deletesFile && !descriptive) {
    push("assertion-removed", `this patch removes ${beforeAsserts - afterAsserts} of ${beforeAsserts} assertion call(s). Tests cannot be deleted to make verification pass.`, `${beforeAsserts} → ${afterAsserts}`);
  }

  if (touchesTests && !descriptive) {
    const beforeBlocks = (before.match(new RegExp(TEST_BLOCKS.source, "g")) || []).length;
    const afterBlocks = (after.match(new RegExp(TEST_BLOCKS.source, "g")) || []).length;
    if (beforeBlocks > 0 && afterBlocks < beforeBlocks) {
      push("test-block-removed", `this patch removes ${beforeBlocks - afterBlocks} test block(s) (${beforeBlocks} → ${afterBlocks}). Fix the behaviour they check.`, `${beforeBlocks} → ${afterBlocks}`);
    }
  }

  if (deletesFile && isTestPath(filePath)) {
    push("test-file-deleted", "this patch deletes a test file. If the test is wrong, correct it in place and say why — deleting it removes the evidence.", filePath);
  }

  return { safe: violations.length === 0, violations, touchesTests };
}

/** One-line summary for a refusal or an approval prompt. */
export function formatPatchSafetyForUser(review: PatchSafetyReview): string {
  return review.violations
    .map((v) => `${v.reason} [${v.rule}] → ${JSON.stringify(v.evidence)}`)
    .join("\n");
}
