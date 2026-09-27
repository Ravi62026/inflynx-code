import fs from "fs";
import path from "path";

/**
 * The one authority for "where is the workspace root".
 *
 * Extracted from `index.ts` so `mcp-config.ts` can use it without importing the
 * package barrel (which would be a cycle). Phase 5 of the backlog established a
 * single root per session for *tools*; this is the same rule for *config* — every
 * lookup of `.inflynx/**` has to agree on which directory it means, or trust
 * decisions and config reads can disagree about which file they're looking at.
 *
 * ## Why the marker order matters (backlog N7)
 *
 * `.inflynx/` used to be accepted as a root marker on the way up, *before* any
 * workspace declaration higher in the tree. That is the wrong precedence, because the
 * two files mean different things:
 *
 * - `pnpm-workspace.yaml` / `.git` — a declaration about **the project**: this is its
 *   boundary.
 * - `.inflynx/` — a record that **some tool once ran here**. It is state, not intent.
 *
 * So a stray `apps/cli/.inflynx` (created by one CLI run started inside `apps/cli`)
 * captured the root there, and every later run was confined to one package of a
 * nineteen-package monorepo — verified live: `pnpm dev` resolved the root to
 * `apps/cli`, and the agent could not read `packages/*` at all. It is also
 * self-reinforcing: the first run makes the marker, the second is imprisoned by it.
 *
 * This is a security-relevant change in the *widening* direction — the sandbox boundary
 * moves outward to the declared project root. That is the point (an agent that cannot
 * see the code it is working on is not usable), but it is why the fallbacks below are
 * ordered by how strongly each file states an intent, and why a bare `.inflynx` is never
 * preferred over a real project marker found above it.
 */

/**
 * Precedence, strongest declaration first — implemented by the single walk below:
 *   pnpm-workspace.yaml → package.json#workspaces → .git → .inflynx → outermost package.json
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  const start = path.resolve(startDir);

  // Nearest declaration of each kind wins within its kind: a nested `.git` means a
  // nested repository, and the inner one is the project the caller is standing in.
  let workspaceFile: string | null = null;   // pnpm-workspace.yaml
  let gitRoot: string | null = null;          // .git (directory or file for worktrees)
  let stateDir: string | null = null;         // .inflynx  — weakest, see above
  let pkgWithWorkspaces: string | null = null; // package.json that declares "workspaces"
  let nearestPackageJson: string | null = null;
  let farthestPackageJson: string | null = null;

  let curr = start;
  for (;;) {
    if (workspaceFile === null && fs.existsSync(path.join(curr, "pnpm-workspace.yaml"))) {
      workspaceFile = curr;
    }
    if (gitRoot === null) {
      try {
        if (fs.existsSync(path.join(curr, ".git"))) gitRoot = curr;
      } catch {
        /* unreadable directory in the chain: keep walking */
      }
    }
    if (pkgWithWorkspaces === null && declaresWorkspaces(curr)) {
      pkgWithWorkspaces = curr;
    }
    if (stateDir === null && fs.existsSync(path.join(curr, ".inflynx"))) {
      stateDir = curr;
    }
    if (fs.existsSync(path.join(curr, "package.json"))) {
      if (nearestPackageJson === null) nearestPackageJson = curr;
      farthestPackageJson = curr; // keeps overwriting, so the last one is the outermost
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  // Stop early once the strongest possible declaration is in hand.
  if (workspaceFile) return workspaceFile;
  if (pkgWithWorkspaces) return pkgWithWorkspaces;
  if (gitRoot) return gitRoot;
  if (stateDir) return stateDir;

  // Last resort, unchanged from before: the outermost package.json, which is what a
  // bare cloned package looks like. Returning `start` here instead would make a tool
  // run from `/` or `$HOME` claim that as its workspace.
  return farthestPackageJson ?? nearestPackageJson ?? start;
}

/**
 * `workspaces` in package.json is the npm/yarn equivalent of pnpm-workspace.yaml.
 * Parsed narrowly on purpose: an unreadable or malformed file must not crash root
 * discovery for everyone, it just stops counting as a marker.
 */
function declaresWorkspaces(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    // Cheap pre-check before parsing: most package.json files have no workspaces key.
    if (!raw.includes("\"workspaces\"")) return false;
    const parsed = JSON.parse(raw);
    return Boolean(parsed && (parsed.workspaces || parsed.workspaces === ""));
  } catch {
    return false;
  }
}

/** Exposed for diagnostics and tests: which marker class decided a given root. */
export function describeWorkspaceRootSource(dir: string = process.cwd()): string {
  const resolved = findWorkspaceRoot(dir);
  const has = (f: string) => fs.existsSync(path.join(resolved, f));
  if (has("pnpm-workspace.yaml")) return "pnpm-workspace.yaml";
  if (has("package.json") && declaresWorkspaces(resolved)) return "package.json#workspaces";
  if (has(".git")) return ".git";
  if (has(".inflynx")) return ".inflynx (no stronger marker found above it)";
  return "outermost package.json";
}
