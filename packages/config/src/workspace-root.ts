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
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let curr = path.resolve(startDir);
  while (true) {
    if (
      fs.existsSync(path.join(curr, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(curr, ".inflynx"))
    ) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }

  // Fallback: farthest parent containing package.json
  curr = path.resolve(startDir);
  let rootCandidate = curr;
  while (true) {
    if (fs.existsSync(path.join(curr, "package.json"))) {
      rootCandidate = curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return rootCandidate;
}
