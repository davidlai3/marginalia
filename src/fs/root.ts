import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export class PathOutsideRootError extends Error {
  constructor(public readonly requested: string) {
    super(`path escapes root: ${requested}`);
    this.name = "PathOutsideRootError";
  }
}

/**
 * Resolve `requested` (always relative) against `root`, following symlinks,
 * and guarantee the result stays inside the root. Non-existent files are
 * allowed — the parent directory is what gets the symlink check.
 */
export function resolveInRoot(root: string, requested: string): string {
  if (isAbsolute(requested)) throw new PathOutsideRootError(requested);

  const rootReal = realpathSync(root);
  const candidate = resolve(rootReal, requested);
  const real = realpathBestEffort(candidate);
  const rel = relative(rootReal, real);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathOutsideRootError(requested);
  }
  return real;
}

/**
 * Resolve `p` as far as it exists on disk, following symlinks all the way
 * down. When `p` (or some suffix of it) does not exist yet, walk upward
 * component by component until an ancestor that does exist is found,
 * `realpathSync` that ancestor (resolving any symlinked directory in the
 * chain), and re-append the non-existent trailing segments. This ensures a
 * symlinked directory two or more levels above a missing leaf is still
 * caught by the containment check in `resolveInRoot`.
 */
function realpathBestEffort(p: string): string {
  const pending: string[] = [];
  let current = p;

  for (;;) {
    try {
      const real = realpathSync(current);
      return pending.length === 0 ? real : join(real, ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor.
        return p;
      }
      pending.push(basename(current));
      current = parent;
    }
  }
}
