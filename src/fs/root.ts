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

function realpathBestEffort(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}
