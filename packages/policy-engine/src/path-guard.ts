import fs from "fs";
import path from "path";

/**
 * @inflynx/policy-engine — CanonicalPathGuard
 * 
 * Symlink-safe canonical path validation engine.
 * Resolves all paths to their true physical disk location using `fs.realpathSync`,
 * protecting against symlink escapes, path traversals (`..`), and virtual directory spoofs.
 */
export class CanonicalPathGuard {
  private readonly canonicalWorkspaceRoot: string;

  constructor(workspaceRoot: string) {
    const absRoot = path.resolve(workspaceRoot);
    if (!fs.existsSync(absRoot)) {
      throw new Error(`Workspace root directory does not exist: "${absRoot}"`);
    }
    this.canonicalWorkspaceRoot = fs.realpathSync(absRoot);
  }

  /**
   * Returns the canonical, symlink-resolved workspace root directory path.
   */
  getWorkspaceRoot(): string {
    return this.canonicalWorkspaceRoot;
  }

  /**
   * Resolves a target path (relative or absolute) to its canonical physical path
   * and verifies that it resides strictly within the workspace boundary.
   * 
   * Handles:
   * 1. Existing files/directories: direct `fs.realpathSync` resolution.
   * 2. Non-existent files (new creation): resolves nearest existing parent directory's `fs.realpathSync`.
   * 3. Symlinks: resolves target target to prevent escaping workspace via symlinked folders.
   * 
   * @throws Error if the canonical path escapes the workspace root.
   */
  validateAndResolve(targetPath: string): string {
    if (!targetPath || typeof targetPath !== "string") {
      throw new Error("Invalid target path: Path must be a non-empty string.");
    }

    // Reject NULL bytes in path string (common path traversal attack vector)
    if (targetPath.includes("\0")) {
      throw new Error("Security Violation: Path contains NULL byte character.");
    }

    const absoluteTarget = path.isAbsolute(targetPath)
      ? path.normalize(targetPath)
      : path.normalize(path.join(this.canonicalWorkspaceRoot, targetPath));

    let canonicalTarget: string;

    if (fs.existsSync(absoluteTarget)) {
      canonicalTarget = fs.realpathSync(absoluteTarget);
    } else {
      // For non-existent files being created, walk up to the nearest existing parent directory
      let currentDir = path.dirname(absoluteTarget);
      const relativeTailComponents: string[] = [path.basename(absoluteTarget)];

      while (!fs.existsSync(currentDir)) {
        const parent = path.dirname(currentDir);
        if (parent === currentDir) {
          throw new Error(`Invalid path: Nearest root directory does not exist for "${targetPath}".`);
        }
        relativeTailComponents.unshift(path.basename(currentDir));
        currentDir = parent;
      }

      const canonicalParent = fs.realpathSync(currentDir);
      canonicalTarget = path.join(canonicalParent, ...relativeTailComponents);
    }

    // Enforce workspace boundary
    if (!this.isCanonicalSubpath(canonicalTarget, this.canonicalWorkspaceRoot)) {
      throw new Error(
        `Security Policy Violation: Path "${targetPath}" resolves to physical location "${canonicalTarget}", ` +
        `which lies outside allowed workspace root "${this.canonicalWorkspaceRoot}".`
      );
    }

    return canonicalTarget;
  }

  /**
   * Safe boolean check verifying if a target path lies within workspace root.
   */
  isWithinBoundary(targetPath: string): boolean {
    try {
      this.validateAndResolve(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper function checking if `subpath` is identical to or inside `parentPath`.
   */
  private isCanonicalSubpath(subpath: string, parentPath: string): boolean {
    if (subpath === parentPath) return true;
    const relative = path.relative(parentPath, subpath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }
}
