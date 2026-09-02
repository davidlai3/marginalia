import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInRoot, PathOutsideRootError } from "../src/fs/root.js";

let root: string;
let outside: string;

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), "marginalia-root-"));
  root = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(outside, "secret.txt"), "nope\n");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  symlinkSync(outside, join(root, "linkdir"), "dir");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveInRoot", () => {
  it("resolves a plain relative path", () => {
    expect(resolveInRoot(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
  });

  it("resolves a path that does not exist yet", () => {
    expect(resolveInRoot(root, "src/missing.ts")).toBe(join(root, "src", "missing.ts"));
  });

  it("rejects parent traversal", () => {
    expect(() => resolveInRoot(root, "../outside/secret.txt")).toThrow(PathOutsideRootError);
  });

  it("rejects absolute paths", () => {
    expect(() => resolveInRoot(root, join(outside, "secret.txt"))).toThrow(PathOutsideRootError);
  });

  it("rejects a symlink pointing out of the root", () => {
    expect(() => resolveInRoot(root, "escape.txt")).toThrow(PathOutsideRootError);
  });

  it("rejects the root itself", () => {
    expect(() => resolveInRoot(root, ".")).toThrow(PathOutsideRootError);
  });

  it("rejects a nested non-existent path beneath a symlinked directory escaping the root", () => {
    // `linkdir` -> `outside`, and `outside/sub` does not exist. The
    // candidate path is two levels below the symlink, so the containment
    // check must walk up past both missing segments to find `linkdir`
    // itself before it can discover the escape.
    expect(() => resolveInRoot(root, "linkdir/sub/newfile.txt")).toThrow(PathOutsideRootError);
  });
});
