# marginalia Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that renders ephemeral, numbered code annotations emitted by an agent into a local browser viewer, without modifying any source file.

**Architecture:** One TypeScript package with two halves. The MCP half speaks stdio, validates an agent-supplied layer against the real files on disk, assigns step numbers, and hands the result to the viewer half. The viewer half is a localhost HTTP + WebSocket server serving a dependency-free SPA that draws a single scrolling reading path. No retrieval, no LLM calls, no API keys — the agent has already read the code.

**Tech Stack:** Node 20+, TypeScript (strict), `@modelcontextprotocol/sdk`, `zod` 3, `ws`, `highlight.js`, `vitest` + `happy-dom`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-09-02-marginalia-design.md`

## Global Constraints

- Node `>=20.0.0`. ESM only (`"type": "module"`), `moduleResolution: "bundler"`.
- TypeScript `strict: true`. No `any` in exported signatures.
- Runtime dependencies limited to exactly: `@modelcontextprotocol/sdk`, `zod` (^3.23), `ws`, `highlight.js`. Nothing else.
- The viewer client uses no framework. Vanilla TS + DOM.
- Layers are ephemeral. No file is ever written into the user's repository, and no layer is persisted to disk.
- Step numbers are assigned by the server. The agent-facing schema has no number field, and supplying one is a validation error.
- Branch nesting is capped at depth 1 *structurally* — `BranchStep` has no `branches` key and schemas are `.strict()`.
- Anchor search radius is `40` lines. Context expansion is `20` lines per click.
- Every path supplied by an agent resolves inside the root or is rejected. The root is `process.cwd()`, overridable with `--root`.
- Commit after every task.

---

### Task 1: Scaffold and path safety

The root guard is the security boundary for the whole tool, so it ships first with the project skeleton folded into it.

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/fs/root.ts`
- Test: `tests/root.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `resolveInRoot(root: string, requested: string): string` — returns an absolute real path guaranteed inside `root`. Throws `PathOutsideRootError` (exported class, has a `requested: string` property) otherwise.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "marginalia",
  "version": "0.1.0",
  "type": "module",
  "bin": { "marginalia": "dist/index.js" },
  "engines": { "node": ">=20.0.0" },
  "scripts": {
    "build": "tsc && npm run build:client",
    "build:client": "esbuild src/viewer/client/main.ts --bundle --format=esm --outfile=dist/client/main.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "highlight.js": "^11.10.0",
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.12",
    "esbuild": "^0.24.0",
    "happy-dom": "^15.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: completes, `node_modules/` present.

- [ ] **Step 5: Write the failing test**

Create `tests/root.test.ts`:

```ts
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
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/root.test.ts`
Expected: FAIL — cannot resolve `../src/fs/root.js`.

- [ ] **Step 7: Write the implementation**

Create `src/fs/root.ts`:

```ts
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
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/root.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/fs/root.ts tests/root.test.ts
git commit -m "feat: scaffold project and add root path guard"
```

---

### Task 2: Layer schema

**Files:**
- Create: `src/layer/schema.ts`
- Test: `tests/schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `LayerInputSchema` (zod) and `type LayerInput = { title: string; steps: StepInput[] }`
  - `type StepInput = { file: string; start_line: number; end_line: number; first_line_text: string; note: string; edge_label?: string; branches?: BranchInput[] }`
  - `type BranchInput = { condition: string; steps: BranchStepInput[] }`
  - `type BranchStepInput` — identical to `StepInput` minus `branches`
  - `layerInputShape` — the raw zod shape object, for MCP tool registration in Task 9

- [ ] **Step 1: Write the failing test**

Create `tests/schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LayerInputSchema } from "../src/layer/schema.js";

const step = {
  file: "src/a.ts",
  start_line: 1,
  end_line: 3,
  first_line_text: "export const a = 1;",
  note: "the thing",
};

describe("LayerInputSchema", () => {
  it("accepts a minimal single-step layer", () => {
    const r = LayerInputSchema.safeParse({ title: "T", steps: [step] });
    expect(r.success).toBe(true);
  });

  it("accepts one level of branching", () => {
    const r = LayerInputSchema.safeParse({
      title: "T",
      steps: [{ ...step, branches: [{ condition: "if err", steps: [step] }] }],
    });
    expect(r.success).toBe(true);
  });

  it("rejects depth-2 branching", () => {
    const nested = { ...step, branches: [{ condition: "inner", steps: [step] }] };
    const r = LayerInputSchema.safeParse({
      title: "T",
      steps: [{ ...step, branches: [{ condition: "outer", steps: [nested] }] }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an inverted line range", () => {
    const r = LayerInputSchema.safeParse({
      title: "T",
      steps: [{ ...step, start_line: 9, end_line: 2 }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a zero or negative start_line", () => {
    expect(LayerInputSchema.safeParse({ title: "T", steps: [{ ...step, start_line: 0 }] }).success).toBe(false);
  });

  it("rejects an agent-supplied step number", () => {
    const r = LayerInputSchema.safeParse({ title: "T", steps: [{ ...step, n: "1" }] });
    expect(r.success).toBe(false);
  });

  it("rejects an empty steps array", () => {
    expect(LayerInputSchema.safeParse({ title: "T", steps: [] }).success).toBe(false);
  });

  it("rejects a missing fingerprint", () => {
    const { first_line_text, ...noFingerprint } = step;
    expect(LayerInputSchema.safeParse({ title: "T", steps: [noFingerprint] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/schema.test.ts`
Expected: FAIL — cannot resolve `../src/layer/schema.js`.

- [ ] **Step 3: Write the implementation**

Create `src/layer/schema.ts`:

```ts
import { z } from "zod";

const baseStepShape = {
  file: z.string().min(1).describe("Path to the file, relative to the repository root."),
  start_line: z.number().int().positive().describe("1-based first line of the excerpt."),
  end_line: z.number().int().positive().describe("1-based last line of the excerpt, inclusive."),
  first_line_text: z
    .string()
    .describe("Exact text of the line at start_line. Used to verify the anchor before publishing."),
  note: z.string().min(1).describe("The annotation shown in the margin beside this excerpt."),
  edge_label: z
    .string()
    .optional()
    .describe("How control flow reaches the next step, e.g. 'calls verify()'."),
};

function checkRange(
  s: { start_line: number; end_line: number },
  ctx: z.RefinementCtx,
): void {
  if (s.end_line < s.start_line) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "end_line must be greater than or equal to start_line",
      path: ["end_line"],
    });
  }
}

/** A step inside a branch. Deliberately has no `branches` key — this is the depth cap. */
export const BranchStepSchema = z.object(baseStepShape).strict().superRefine(checkRange);

export const BranchSchema = z
  .object({
    condition: z.string().min(1).describe("The condition under which this fork is taken."),
    steps: z.array(BranchStepSchema).min(1),
  })
  .strict();

export const StepSchema = z
  .object({
    ...baseStepShape,
    branches: z.array(BranchSchema).optional().describe("At most one level of forks off this step."),
  })
  .strict()
  .superRefine(checkRange);

export const layerInputShape = {
  title: z.string().min(1).describe("The question this layer answers."),
  steps: z.array(StepSchema).min(1),
};

export const LayerInputSchema = z.object(layerInputShape).strict();

export type LayerInput = z.infer<typeof LayerInputSchema>;
export type StepInput = z.infer<typeof StepSchema>;
export type BranchInput = z.infer<typeof BranchSchema>;
export type BranchStepInput = z.infer<typeof BranchStepSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/schema.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/layer/schema.ts tests/schema.test.ts
git commit -m "feat: add layer schema with structural branch-depth cap"
```

---

### Task 3: Step numbering

**Files:**
- Create: `src/layer/number.ts`
- Test: `tests/number.test.ts`

**Interfaces:**
- Consumes: `LayerInput`, `StepInput`, `BranchStepInput` from `src/layer/schema.ts`
- Produces:
  - `type NumberedBranchStep = BranchStepInput & { n: string }`
  - `type NumberedBranch = { condition: string; steps: NumberedBranchStep[] }`
  - `type NumberedStep = Omit<StepInput, "branches"> & { n: string; branches?: NumberedBranch[] }`
  - `type NumberedLayer = { title: string; steps: NumberedStep[] }`
  - `assignNumbers(layer: LayerInput): NumberedLayer`

Numbering rule: spine steps are `"1"`, `"2"`, … in order. Branch steps take the parent's number plus a letter, and letters run continuously across *all* branches of the same parent — a step with two 2-step branches yields `2a`, `2b`, `2c`, `2d`. Past 26, letters roll over to `aa`, `ab`.

- [ ] **Step 1: Write the failing test**

Create `tests/number.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assignNumbers } from "../src/layer/number.js";
import type { LayerInput } from "../src/layer/schema.js";

const s = (note: string) => ({
  file: "a.ts",
  start_line: 1,
  end_line: 1,
  first_line_text: "x",
  note,
});

describe("assignNumbers", () => {
  it("numbers the spine from 1", () => {
    const layer: LayerInput = { title: "T", steps: [s("one"), s("two"), s("three")] };
    expect(assignNumbers(layer).steps.map((x) => x.n)).toEqual(["1", "2", "3"]);
  });

  it("letters branch steps under their parent", () => {
    const layer: LayerInput = {
      title: "T",
      steps: [s("one"), { ...s("two"), branches: [{ condition: "if err", steps: [s("err")] }] }],
    };
    const out = assignNumbers(layer);
    expect(out.steps[1]?.branches?.[0]?.steps.map((x) => x.n)).toEqual(["2a"]);
  });

  it("runs letters continuously across sibling branches of one parent", () => {
    const layer: LayerInput = {
      title: "T",
      steps: [
        {
          ...s("one"),
          branches: [
            { condition: "a", steps: [s("x"), s("y")] },
            { condition: "b", steps: [s("z")] },
          ],
        },
      ],
    };
    const out = assignNumbers(layer);
    expect(out.steps[0]?.branches?.[0]?.steps.map((x) => x.n)).toEqual(["1a", "1b"]);
    expect(out.steps[0]?.branches?.[1]?.steps.map((x) => x.n)).toEqual(["1c"]);
  });

  it("rolls letters over past z", () => {
    const many = Array.from({ length: 27 }, (_, i) => s(`n${i}`));
    const layer: LayerInput = {
      title: "T",
      steps: [{ ...s("one"), branches: [{ condition: "c", steps: many }] }],
    };
    const labels = assignNumbers(layer).steps[0]?.branches?.[0]?.steps.map((x) => x.n);
    expect(labels?.[25]).toBe("1z");
    expect(labels?.[26]).toBe("1aa");
  });

  it("preserves the title and every other field", () => {
    const layer: LayerInput = { title: "How auth works", steps: [{ ...s("one"), edge_label: "calls f()" }] };
    const out = assignNumbers(layer);
    expect(out.title).toBe("How auth works");
    expect(out.steps[0]?.edge_label).toBe("calls f()");
    expect(out.steps[0]?.file).toBe("a.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/number.test.ts`
Expected: FAIL — cannot resolve `../src/layer/number.js`.

- [ ] **Step 3: Write the implementation**

Create `src/layer/number.ts`:

```ts
import type { BranchStepInput, LayerInput, StepInput } from "./schema.js";

export type NumberedBranchStep = BranchStepInput & { n: string };
export type NumberedBranch = { condition: string; steps: NumberedBranchStep[] };
export type NumberedStep = Omit<StepInput, "branches"> & {
  n: string;
  branches?: NumberedBranch[];
};
export type NumberedLayer = { title: string; steps: NumberedStep[] };

/** 0 -> "a", 25 -> "z", 26 -> "aa". */
export function alphaLabel(index: number): string {
  let i = index + 1;
  let out = "";
  while (i > 0) {
    const r = (i - 1) % 26;
    out = String.fromCharCode(97 + r) + out;
    i = Math.floor((i - 1) / 26);
  }
  return out;
}

export function assignNumbers(layer: LayerInput): NumberedLayer {
  return {
    title: layer.title,
    steps: layer.steps.map((step, i) => {
      const n = String(i + 1);
      const { branches, ...rest } = step;
      if (!branches) return { ...rest, n };

      let letter = 0;
      const numbered: NumberedBranch[] = branches.map((branch) => ({
        condition: branch.condition,
        steps: branch.steps.map((bs) => ({ ...bs, n: `${n}${alphaLabel(letter++)}` })),
      }));
      return { ...rest, n, branches: numbered };
    }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/number.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/layer/number.ts tests/number.test.ts
git commit -m "feat: assign spine and branch step numbers server-side"
```

---

### Task 4: Anchor resolution

The safety story of the whole tool. A note beside the wrong snippet is worse than no tool, so this task both corrects small drift and refuses to publish when it cannot.

**Files:**
- Create: `src/layer/anchor.ts`
- Test: `tests/anchor.test.ts`

**Interfaces:**
- Consumes: `resolveInRoot` (Task 1), `LayerInput` (Task 2)
- Produces:
  - `SEARCH_RADIUS = 40`
  - `type AnchorOk = { ok: true; start_line: number; end_line: number }`
  - `type AnchorFail = { ok: false; reason: "not_found" | "ambiguous" | "missing_file"; found: string | null }`
  - `resolveAnchor(lines: string[], target: { start_line: number; end_line: number; first_line_text: string }): AnchorOk | AnchorFail` — pure, no file IO
  - `type BadAnchor = { index: number; file: string; expected: string; found: string | null; reason: string }`
  - `resolveLayerAnchors(root: string, layer: LayerInput): { ok: true; layer: LayerInput } | { ok: false; bad_anchors: BadAnchor[] }` — walks spine and branch steps, reads files, returns a layer with corrected ranges or the list of failures.
  - `readFileLines(path: string): string[]`

Matching compares `String.prototype.trim()` on both sides, so an agent that normalizes indentation still anchors. Uniqueness within the window is what protects against a sloppy match.

`index` in `BadAnchor` is the position in a flattened walk order: spine steps first-to-last, and immediately after each spine step, its branch steps in order. This is the same order the numbers are assigned in, so the agent can map an index back to a step it can see.

- [ ] **Step 1: Write the failing test for the pure resolver**

Create `tests/anchor.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAnchor, resolveLayerAnchors } from "../src/layer/anchor.js";
import type { LayerInput } from "../src/layer/schema.js";

const lines = [
  "line one",
  "line two",
  "  target line  ",
  "line four",
  "line five",
];

describe("resolveAnchor", () => {
  it("accepts an exact hit at the requested line", () => {
    const r = resolveAnchor(lines, { start_line: 3, end_line: 4, first_line_text: "  target line  " });
    expect(r).toEqual({ ok: true, start_line: 3, end_line: 4 });
  });

  it("matches ignoring surrounding whitespace", () => {
    const r = resolveAnchor(lines, { start_line: 3, end_line: 3, first_line_text: "target line" });
    expect(r.ok).toBe(true);
  });

  it("shifts the whole range when the text moved", () => {
    const r = resolveAnchor(lines, { start_line: 1, end_line: 2, first_line_text: "target line" });
    expect(r).toEqual({ ok: true, start_line: 3, end_line: 4 });
  });

  it("fails when the text is nowhere in the window", () => {
    const r = resolveAnchor(lines, { start_line: 1, end_line: 1, first_line_text: "not here" });
    expect(r).toMatchObject({ ok: false, reason: "not_found", found: "line one" });
  });

  it("fails as ambiguous when the text appears more than once", () => {
    const dup = ["a", "dup", "b", "dup", "c"];
    const r = resolveAnchor(dup, { start_line: 1, end_line: 1, first_line_text: "dup" });
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("prefers the exact requested line over a duplicate elsewhere", () => {
    const dup = ["a", "dup", "b", "dup", "c"];
    const r = resolveAnchor(dup, { start_line: 2, end_line: 2, first_line_text: "dup" });
    expect(r).toEqual({ ok: true, start_line: 2, end_line: 2 });
  });

  it("clamps end_line to the end of the file", () => {
    const r = resolveAnchor(lines, { start_line: 3, end_line: 99, first_line_text: "target line" });
    expect(r).toEqual({ ok: true, start_line: 3, end_line: 5 });
  });

  it("reports found as null when the requested line is past the end", () => {
    const r = resolveAnchor(lines, { start_line: 99, end_line: 99, first_line_text: "nope" });
    expect(r).toMatchObject({ ok: false, found: null });
  });

  it("does not search beyond the radius", () => {
    const far = ["target", ...Array.from({ length: 200 }, () => "filler")];
    const r = resolveAnchor(far, { start_line: 150, end_line: 150, first_line_text: "target" });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/anchor.test.ts`
Expected: FAIL — cannot resolve `../src/layer/anchor.js`.

- [ ] **Step 3: Write the pure resolver**

Create `src/layer/anchor.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolveInRoot } from "../fs/root.js";
import type { LayerInput } from "./schema.js";

export const SEARCH_RADIUS = 40;

export type AnchorOk = { ok: true; start_line: number; end_line: number };
export type AnchorFail = {
  ok: false;
  reason: "not_found" | "ambiguous" | "missing_file";
  found: string | null;
};
export type AnchorResult = AnchorOk | AnchorFail;

export interface AnchorTarget {
  start_line: number;
  end_line: number;
  first_line_text: string;
}

const norm = (s: string): string => s.trim();

export function resolveAnchor(lines: string[], target: AnchorTarget): AnchorResult {
  const want = norm(target.first_line_text);
  const requested = target.start_line - 1;
  const atRequested = lines[requested];
  const span = target.end_line - target.start_line;

  const accept = (startIndex: number): AnchorOk => ({
    ok: true,
    start_line: startIndex + 1,
    end_line: Math.min(startIndex + 1 + span, lines.length),
  });

  if (atRequested !== undefined && norm(atRequested) === want) return accept(requested);

  const lo = Math.max(0, requested - SEARCH_RADIUS);
  const hi = Math.min(lines.length - 1, requested + SEARCH_RADIUS);
  const hits: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (norm(lines[i] as string) === want) hits.push(i);
  }

  const found = atRequested ?? null;
  if (hits.length === 1) return accept(hits[0] as number);
  if (hits.length > 1) return { ok: false, reason: "ambiguous", found };
  return { ok: false, reason: "not_found", found };
}

export function readFileLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}
```

- [ ] **Step 4: Run test to verify the pure resolver passes**

Run: `npx vitest run tests/anchor.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing test for the layer walker**

Append to `tests/anchor.test.ts`:

```ts
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "marginalia-anchor-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "alpha\nbravo\ncharlie\ndelta\n");
  writeFileSync(join(root, "src", "b.ts"), "echo\nfoxtrot\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const mk = (over: Partial<LayerInput["steps"][number]> = {}) => ({
  file: "src/a.ts",
  start_line: 2,
  end_line: 2,
  first_line_text: "bravo",
  note: "n",
  ...over,
});

describe("resolveLayerAnchors", () => {
  it("returns the layer unchanged when every anchor is exact", () => {
    const r = resolveLayerAnchors(root, { title: "T", steps: [mk()] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layer.steps[0]?.start_line).toBe(2);
  });

  it("rewrites a drifted range in place", () => {
    const r = resolveLayerAnchors(root, { title: "T", steps: [mk({ start_line: 4, end_line: 4 })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.layer.steps[0]).toMatchObject({ start_line: 2, end_line: 2 });
  });

  it("collects a bad anchor instead of publishing", () => {
    const r = resolveLayerAnchors(root, { title: "T", steps: [mk({ first_line_text: "zulu" })] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.bad_anchors).toHaveLength(1);
      expect(r.bad_anchors[0]).toMatchObject({ index: 0, file: "src/a.ts", expected: "zulu", reason: "not_found" });
    }
  });

  it("reports a missing file", () => {
    const r = resolveLayerAnchors(root, { title: "T", steps: [mk({ file: "src/nope.ts" })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.bad_anchors[0]?.reason).toBe("missing_file");
  });

  it("rejects a path outside the root as a bad anchor, not a crash", () => {
    const r = resolveLayerAnchors(root, { title: "T", steps: [mk({ file: "../escape.ts" })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.bad_anchors[0]?.reason).toBe("missing_file");
  });

  it("checks branch steps too, and indexes them after their parent", () => {
    const layer: LayerInput = {
      title: "T",
      steps: [
        mk(),
        { ...mk(), branches: [{ condition: "c", steps: [{ ...mk(), first_line_text: "zulu" }] }] },
      ],
    };
    const r = resolveLayerAnchors(root, layer);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.bad_anchors[0]?.index).toBe(2);
  });

  it("resolves anchors across several files", () => {
    const layer: LayerInput = {
      title: "T",
      steps: [mk(), mk({ file: "src/b.ts", start_line: 1, end_line: 1, first_line_text: "echo" })],
    };
    expect(resolveLayerAnchors(root, layer).ok).toBe(true);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/anchor.test.ts -t resolveLayerAnchors`
Expected: FAIL — `resolveLayerAnchors is not a function`.

- [ ] **Step 7: Implement the layer walker**

Append to `src/layer/anchor.ts`:

```ts
export interface BadAnchor {
  index: number;
  file: string;
  expected: string;
  found: string | null;
  reason: AnchorFail["reason"];
}

export type LayerAnchorResult =
  | { ok: true; layer: LayerInput }
  | { ok: false; bad_anchors: BadAnchor[] };

/**
 * Verify every anchor in the layer against disk. Small drift is corrected in
 * place; anything unresolvable is collected so the caller can hand it back to
 * the agent instead of publishing a wrong page.
 */
export function resolveLayerAnchors(root: string, layer: LayerInput): LayerAnchorResult {
  const bad: BadAnchor[] = [];
  const cache = new Map<string, string[] | null>();
  let index = 0;

  const linesFor = (file: string): string[] | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let lines: string[] | null;
    try {
      lines = readFileLines(resolveInRoot(root, file));
    } catch {
      lines = null;
    }
    cache.set(file, lines);
    return lines;
  };

  const fix = <T extends { file: string; start_line: number; end_line: number; first_line_text: string }>(
    step: T,
  ): T => {
    const i = index++;
    const lines = linesFor(step.file);
    if (lines === null) {
      bad.push({
        index: i,
        file: step.file,
        expected: step.first_line_text,
        found: null,
        reason: "missing_file",
      });
      return step;
    }
    const r = resolveAnchor(lines, step);
    if (!r.ok) {
      bad.push({
        index: i,
        file: step.file,
        expected: step.first_line_text,
        found: r.found,
        reason: r.reason,
      });
      return step;
    }
    return { ...step, start_line: r.start_line, end_line: r.end_line };
  };

  const steps = layer.steps.map((step) => {
    const fixed = fix(step);
    if (!fixed.branches) return fixed;
    return {
      ...fixed,
      branches: fixed.branches.map((b) => ({ ...b, steps: b.steps.map(fix) })),
    };
  });

  if (bad.length > 0) return { ok: false, bad_anchors: bad };
  return { ok: true, layer: { title: layer.title, steps } };
}
```

- [ ] **Step 8: Run the whole anchor suite**

Run: `npx vitest run tests/anchor.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 9: Commit**

```bash
git add src/layer/anchor.ts tests/anchor.test.ts
git commit -m "feat: verify and self-correct anchors against disk"
```

---

### Task 5: Layer store and viewer HTTP server

**Files:**
- Create: `src/viewer/state.ts`
- Create: `src/viewer/server.ts`
- Create: `src/viewer/client/index.html`
- Test: `tests/viewer-server.test.ts`

**Interfaces:**
- Consumes: `resolveInRoot` (Task 1), `NumberedLayer` (Task 3), `readFileLines` (Task 4)
- Produces:
  - `class LayerStore` — `get(): NumberedLayer | null`, `set(l: NumberedLayer): void`, `subscribe(fn: (l: NumberedLayer) => void): () => void`
  - `CONTEXT_LINES = 20`
  - `interface ViewerHandle { url: string; port: number; key: string; store: LayerStore; close(): Promise<void> }`
  - `startViewer(opts: { root: string; store: LayerStore; assetDir: string; host?: string; port?: number }): Promise<ViewerHandle>`

Routes, all requiring the key as `?key=` or the `mg_key` cookie:
- `GET /` → `index.html`
- `GET /client/main.js` → the bundled client from `assetDir`
- `GET /api/layer` → `{ layer: NumberedLayer | null }`
- `GET /api/context?file=&start=&end=` → `{ file, start_line, end_line, lines }`, expanding the given range by `CONTEXT_LINES` on both sides, clamped to the file

- [ ] **Step 1: Write the failing test**

Create `tests/viewer-server.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayerStore } from "../src/viewer/state.js";
import { startViewer, type ViewerHandle } from "../src/viewer/server.js";

let root: string;
let assetDir: string;
let viewer: ViewerHandle;
let base: string;

const layer = {
  title: "T",
  steps: [
    { n: "1", file: "src/a.ts", start_line: 2, end_line: 2, first_line_text: "bravo", note: "hi" },
  ],
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "marginalia-viewer-"));
  assetDir = mkdtempSync(join(tmpdir(), "marginalia-assets-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "a.ts"),
    Array.from({ length: 100 }, (_, i) => (i === 1 ? "bravo" : `line ${i + 1}`)).join("\n"),
  );
  writeFileSync(join(assetDir, "index.html"), "<!doctype html><title>marginalia</title>");
  writeFileSync(join(assetDir, "main.js"), "export const x = 1;");

  const store = new LayerStore();
  store.set(layer);
  viewer = await startViewer({ root, store, assetDir, port: 0 });
  base = `http://127.0.0.1:${viewer.port}`;
});

afterAll(async () => {
  await viewer.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(assetDir, { recursive: true, force: true });
});

describe("viewer server auth", () => {
  it("rejects a request with no key", async () => {
    expect((await fetch(`${base}/api/layer`)).status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    expect((await fetch(`${base}/api/layer?key=wrong`)).status).toBe(401);
  });

  it("accepts the session key", async () => {
    const res = await fetch(`${base}/api/layer?key=${viewer.key}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layer });
  });

  it("accepts the key from a cookie", async () => {
    const res = await fetch(`${base}/api/layer`, { headers: { cookie: `mg_key=${viewer.key}` } });
    expect(res.status).toBe(200);
  });

  it("sets the cookie when the key arrives in the query", async () => {
    const res = await fetch(`${base}/?key=${viewer.key}`);
    expect(res.headers.get("set-cookie")).toContain(`mg_key=${viewer.key}`);
  });
});

describe("GET /api/context", () => {
  const ctx = (qs: string) => fetch(`${base}/api/context?key=${viewer.key}&${qs}`);

  it("expands a range by 20 lines on each side", async () => {
    const res = await ctx("file=src/a.ts&start=50&end=51");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.start_line).toBe(30);
    expect(body.end_line).toBe(71);
    expect(body.lines).toHaveLength(42);
  });

  it("clamps at the start of the file", async () => {
    const body = await (await ctx("file=src/a.ts&start=2&end=2")).json();
    expect(body.start_line).toBe(1);
  });

  it("clamps at the end of the file", async () => {
    const body = await (await ctx("file=src/a.ts&start=99&end=100")).json();
    expect(body.end_line).toBe(100);
  });

  it("rejects a path outside the root", async () => {
    expect((await ctx("file=../escape.ts&start=1&end=1")).status).toBe(400);
  });

  it("rejects a non-numeric range", async () => {
    expect((await ctx("file=src/a.ts&start=abc&end=1")).status).toBe(400);
  });

  it("404s a missing file", async () => {
    expect((await ctx("file=src/nope.ts&start=1&end=1")).status).toBe(404);
  });
});

describe("static assets", () => {
  it("serves index.html at the root", async () => {
    const res = await fetch(`${base}/?key=${viewer.key}`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("marginalia");
  });

  it("serves the client bundle", async () => {
    const res = await fetch(`${base}/client/main.js?key=${viewer.key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/viewer-server.test.ts`
Expected: FAIL — cannot resolve `../src/viewer/state.js`.

- [ ] **Step 3: Write the layer store**

Create `src/viewer/state.ts`:

```ts
import type { NumberedLayer } from "../layer/number.js";

export class LayerStore {
  private layer: NumberedLayer | null = null;
  private listeners = new Set<(layer: NumberedLayer) => void>();

  get(): NumberedLayer | null {
    return this.layer;
  }

  /** Replace the live layer. Only one is ever current — layers are ephemeral. */
  set(layer: NumberedLayer): void {
    this.layer = layer;
    for (const fn of this.listeners) fn(layer);
  }

  subscribe(fn: (layer: NumberedLayer) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
```

- [ ] **Step 4: Write the HTTP server**

Create `src/viewer/server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { resolveInRoot } from "../fs/root.js";
import { readFileLines } from "../layer/anchor.js";
import type { LayerStore } from "./state.js";

export const CONTEXT_LINES = 20;

export interface ViewerHandle {
  url: string;
  port: number;
  key: string;
  store: LayerStore;
  close(): Promise<void>;
}

export interface ViewerOptions {
  root: string;
  store: LayerStore;
  assetDir: string;
  host?: string;
  port?: number;
}

export async function startViewer(opts: ViewerOptions): Promise<ViewerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const key = randomBytes(32).toString("hex");

  const server = createServer((req, res) => {
    try {
      handle(req, res, opts, key);
    } catch {
      send(res, 500, { error: "internal" });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://localhost:${port}/?key=${key}`,
    port,
    key,
    store: opts.store,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function handle(req: IncomingMessage, res: ServerResponse, opts: ViewerOptions, key: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryKey = url.searchParams.get("key");
  const cookieKey = readCookie(req.headers.cookie, "mg_key");

  if (queryKey !== key && cookieKey !== key) {
    send(res, 401, { error: "bad or missing session key" });
    return;
  }
  if (queryKey === key) {
    res.setHeader("Set-Cookie", `mg_key=${key}; Path=/; SameSite=Strict; HttpOnly`);
  }

  switch (url.pathname) {
    case "/":
      sendFile(res, join(opts.assetDir, "index.html"), "text/html; charset=utf-8");
      return;
    case "/client/main.js":
      sendFile(res, join(opts.assetDir, "main.js"), "text/javascript; charset=utf-8");
      return;
    case "/api/layer":
      send(res, 200, { layer: opts.store.get() });
      return;
    case "/api/context":
      sendContext(res, opts.root, url);
      return;
    default:
      send(res, 404, { error: "not found" });
  }
}

function sendContext(res: ServerResponse, root: string, url: URL): void {
  const file = url.searchParams.get("file");
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));

  if (!file || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    send(res, 400, { error: "file, start and end are required; start >= 1 and end >= start" });
    return;
  }

  let lines: string[];
  try {
    lines = readFileLines(resolveInRoot(root, file));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    send(res, code === "ENOENT" ? 404 : 400, { error: "cannot read file" });
    return;
  }

  const startLine = Math.max(1, start - CONTEXT_LINES);
  const endLine = Math.min(lines.length, end + CONTEXT_LINES);
  send(res, 200, {
    file,
    start_line: startLine,
    end_line: endLine,
    lines: lines.slice(startLine - 1, endLine),
  });
}

function sendFile(res: ServerResponse, path: string, contentType: string): void {
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch {
    send(res, 404, { error: "asset not found" });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
```

Note on the `resolveInRoot` failure path: it throws `PathOutsideRootError`, which has no `code`, so the handler falls to `400`. A genuinely missing file throws `ENOENT` from `readFileLines` and yields `404`. Both branches are covered by the tests.

- [ ] **Step 5: Create the client HTML shell**

Create `src/viewer/client/index.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>marginalia</title>
<div id="app"></div>
<script type="module" src="/client/main.js"></script>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/viewer-server.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/state.ts src/viewer/server.ts src/viewer/client/index.html tests/viewer-server.test.ts
git commit -m "feat: add layer store and key-gated viewer HTTP server"
```

---

### Task 6: WebSocket push

**Files:**
- Modify: `src/viewer/server.ts`
- Test: `tests/viewer-ws.test.ts`

**Interfaces:**
- Consumes: `startViewer`, `LayerStore`
- Produces: no new exports. `startViewer` now also accepts WebSocket upgrades at `/ws`, gated by the same key. On connect it sends the current layer (if any); every `store.set` broadcasts to all open sockets. Message shape: `{ type: "layer", layer: NumberedLayer }`.

- [ ] **Step 1: Write the failing test**

Create `tests/viewer-ws.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { LayerStore } from "../src/viewer/state.js";
import { startViewer, type ViewerHandle } from "../src/viewer/server.js";

let root: string;
let assetDir: string;
let store: LayerStore;
let viewer: ViewerHandle;

const mkLayer = (title: string) => ({
  title,
  steps: [{ n: "1", file: "a.ts", start_line: 1, end_line: 1, first_line_text: "x", note: "n" }],
});

const nextMessage = (ws: WebSocket): Promise<any> =>
  new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "marginalia-ws-root-"));
  assetDir = mkdtempSync(join(tmpdir(), "marginalia-ws-assets-"));
  writeFileSync(join(assetDir, "index.html"), "<!doctype html>");
  writeFileSync(join(assetDir, "main.js"), "");
  store = new LayerStore();
  viewer = await startViewer({ root, store, assetDir, port: 0 });
});

afterAll(async () => {
  await viewer.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(assetDir, { recursive: true, force: true });
});

describe("viewer websocket", () => {
  it("refuses an upgrade without the key", async () => {
    await expect(open(`ws://127.0.0.1:${viewer.port}/ws`)).rejects.toBeTruthy();
  });

  it("pushes the current layer on connect", async () => {
    store.set(mkLayer("first"));
    const ws = await open(`ws://127.0.0.1:${viewer.port}/ws?key=${viewer.key}`);
    const msg = await nextMessage(ws);
    expect(msg).toMatchObject({ type: "layer", layer: { title: "first" } });
    ws.close();
  });

  it("broadcasts a replacement layer to open sockets", async () => {
    const ws = await open(`ws://127.0.0.1:${viewer.port}/ws?key=${viewer.key}`);
    await nextMessage(ws); // the on-connect snapshot
    const pending = nextMessage(ws);
    store.set(mkLayer("second"));
    expect(await pending).toMatchObject({ type: "layer", layer: { title: "second" } });
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/viewer-ws.test.ts`
Expected: FAIL — the upgrade is never handled, so `open` hangs or rejects on every case including the ones expected to succeed.

- [ ] **Step 3: Add the WebSocket server**

In `src/viewer/server.ts`, add to the imports:

```ts
import { WebSocketServer } from "ws";
```

Inside `startViewer`, after `server.listen` resolves and before the `return`:

```ts
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ok =
      url.pathname === "/ws" &&
      (url.searchParams.get("key") === key || readCookie(req.headers.cookie, "mg_key") === key);
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const current = opts.store.get();
      if (current) ws.send(JSON.stringify({ type: "layer", layer: current }));
      wss.emit("connection", ws, req);
    });
  });

  const unsubscribe = opts.store.subscribe((layer) => {
    const payload = JSON.stringify({ type: "layer", layer });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  });
```

Then change the returned `close` to tear both down:

```ts
    close: async () => {
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/viewer-ws.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/server.ts tests/viewer-ws.test.ts
git commit -m "feat: push layer replacements to the viewer over websocket"
```

---

### Task 7: Client rendering

**Files:**
- Create: `src/viewer/client/render.ts`
- Create: `src/viewer/client/styles.ts`
- Test: `tests/render.test.ts`

**Interfaces:**
- Consumes: `NumberedLayer`, `NumberedStep`, `NumberedBranch` (Task 3)
- Produces:
  - `renderLayer(layer: NumberedLayer, doc: Document): HTMLElement` — pure, returns a detached element, applies no syntax highlighting
  - `STYLES: string` — the full stylesheet as a string, injected by `main.ts` in Task 8

`renderLayer` produces one `<section class="step">` per spine step and one per branch step, each carrying `data-n`, `data-file`, `data-start`, `data-end`. Inside each: a `.hunk-header` with `file:start-end`, an `<pre><code>` holding the excerpt placeholder lines, a `.note` with the number badge and note text, and — when `edge_label` is set — an `.edge` element after the step. Branches render inside `<div class="branch" data-condition="…">`.

The excerpt body is populated from `/api/context` at runtime (Task 8); at render time each step's `<code>` is empty with `data-pending="1"` so the test can assert structure without file IO.

- [ ] **Step 1: Write the failing test**

Create `tests/render.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderLayer } from "../src/viewer/client/render.js";
import type { NumberedLayer } from "../src/layer/number.js";

const layer: NumberedLayer = {
  title: "How does a request get authenticated?",
  steps: [
    {
      n: "1",
      file: "server/handler.rs",
      start_line: 9,
      end_line: 11,
      first_line_text: "  async fn handle(&self, r: Req) {",
      note: "Entry point.",
      edge_label: "calls verify()",
    },
    {
      n: "2",
      file: "auth/verify.rs",
      start_line: 41,
      end_line: 44,
      first_line_text: "pub fn verify(t: &str) -> Result<Session> {",
      note: "Two gates.",
      branches: [
        {
          condition: "if expired or bad signature",
          steps: [
            {
              n: "2a",
              file: "api/errors.rs",
              start_line: 22,
              end_line: 24,
              first_line_text: "impl From<AuthErr> for Resp {",
              note: "One 401 for everything.",
            },
          ],
        },
      ],
    },
  ],
};

const render = () => renderLayer(layer, document);

describe("renderLayer", () => {
  it("renders the title", () => {
    expect(render().querySelector(".layer-title")?.textContent).toBe(
      "How does a request get authenticated?",
    );
  });

  it("renders one section per step including branch steps", () => {
    expect(render().querySelectorAll("section.step")).toHaveLength(3);
  });

  it("labels each step with its server-assigned number", () => {
    const badges = [...render().querySelectorAll(".badge")].map((b) => b.textContent);
    expect(badges).toEqual(["1", "2", "2a"]);
  });

  it("puts file and line range in the hunk header", () => {
    expect(render().querySelector(".hunk-header")?.textContent).toBe("server/handler.rs:9-11");
  });

  it("carries anchor data attributes for the expander", () => {
    const first = render().querySelector("section.step") as HTMLElement;
    expect(first.dataset.file).toBe("server/handler.rs");
    expect(first.dataset.start).toBe("9");
    expect(first.dataset.end).toBe("11");
  });

  it("renders the note text", () => {
    expect(render().querySelector(".note-text")?.textContent).toBe("Entry point.");
  });

  it("renders an edge label after a step that has one", () => {
    expect(render().querySelector(".edge")?.textContent).toContain("calls verify()");
  });

  it("nests branch steps inside a branch container with its condition", () => {
    const branch = render().querySelector(".branch") as HTMLElement;
    expect(branch.dataset.condition).toBe("if expired or bad signature");
    expect(branch.querySelectorAll("section.step")).toHaveLength(1);
  });

  it("leaves each code block pending for the loader to fill", () => {
    const codes = render().querySelectorAll("code[data-pending='1']");
    expect(codes).toHaveLength(3);
  });

  it("gives every step an expand control", () => {
    expect(render().querySelectorAll("button.expand")).toHaveLength(3);
  });

  it("escapes rather than interprets note markup", () => {
    const evil: NumberedLayer = {
      title: "T",
      steps: [{ ...layer.steps[0]!, note: "<img src=x onerror=alert(1)>", branches: undefined }],
    };
    const el = renderLayer(evil, document);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".note-text")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/render.test.ts`
Expected: FAIL — cannot resolve `../src/viewer/client/render.js`.

- [ ] **Step 3: Write the renderer**

Create `src/viewer/client/render.ts`:

```ts
import type { NumberedBranch, NumberedBranchStep, NumberedLayer, NumberedStep } from "../../layer/number.js";

type AnyStep = NumberedStep | NumberedBranchStep;

export function renderLayer(layer: NumberedLayer, doc: Document): HTMLElement {
  const root = el(doc, "div", "layer");

  const title = el(doc, "h1", "layer-title");
  title.textContent = layer.title;
  root.append(title);

  layer.steps.forEach((step, i) => {
    root.append(renderStep(step, doc));
    if (step.branches) {
      for (const branch of step.branches) root.append(renderBranch(branch, doc));
    }
    const isLast = i === layer.steps.length - 1;
    if (step.edge_label && !isLast) root.append(renderEdge(step.edge_label, doc));
  });

  return root;
}

function renderBranch(branch: NumberedBranch, doc: Document): HTMLElement {
  const wrap = el(doc, "div", "branch");
  wrap.dataset.condition = branch.condition;

  const cond = el(doc, "div", "branch-condition");
  cond.textContent = `└─ ${branch.condition}`;
  wrap.append(cond);

  branch.steps.forEach((step, i) => {
    wrap.append(renderStep(step, doc));
    if (step.edge_label && i < branch.steps.length - 1) {
      wrap.append(renderEdge(step.edge_label, doc));
    }
  });
  return wrap;
}

function renderStep(step: AnyStep, doc: Document): HTMLElement {
  const section = doc.createElement("section");
  section.className = "step";
  section.dataset.n = step.n;
  section.dataset.file = step.file;
  section.dataset.start = String(step.start_line);
  section.dataset.end = String(step.end_line);

  const header = el(doc, "div", "hunk-header");
  header.textContent = `${step.file}:${step.start_line}-${step.end_line}`;

  const expand = doc.createElement("button");
  expand.className = "expand";
  expand.type = "button";
  expand.textContent = "expand";

  const headerRow = el(doc, "div", "hunk-header-row");
  headerRow.append(header, expand);

  const pre = doc.createElement("pre");
  pre.className = "hunk";
  const code = doc.createElement("code");
  code.dataset.pending = "1";
  pre.append(code);

  const note = el(doc, "div", "note");
  const badge = el(doc, "span", "badge");
  badge.textContent = step.n;
  const text = el(doc, "span", "note-text");
  text.textContent = step.note;
  note.append(badge, text);

  section.append(headerRow, pre, note);
  return section;
}

function renderEdge(label: string, doc: Document): HTMLElement {
  const edge = el(doc, "div", "edge");
  edge.textContent = `│ ${label}\n▼`;
  return edge;
}

function el(doc: Document, tag: string, className: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}
```

Every text insertion goes through `textContent`, never `innerHTML` — that is what the escaping test pins.

- [ ] **Step 4: Write the stylesheet**

Create `src/viewer/client/styles.ts`:

```ts
export const STYLES = `
:root {
  --bg: #1b1d23; --panel: #21252b; --fg: #d7dae0; --dim: #7c8598;
  --accent: #d19a66; --err: #e06c75; --rule: rgba(128,128,128,.25);
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, system-ui, sans-serif; }
.layer { max-width: 1100px; margin: 0 auto; padding: 32px 24px 96px; }
.layer-title { font-size: 20px; font-weight: 600; margin: 0 0 24px; }

.step { display: grid; grid-template-columns: 1.6fr 1fr; gap: 0 20px;
  grid-template-areas: "header ." "code note"; margin-bottom: 4px; }
.hunk-header-row { grid-area: header; display: flex; align-items: baseline;
  gap: 10px; padding: 6px 0 3px; }
.hunk-header { font: 11px var(--mono); color: var(--dim); letter-spacing: .02em; }
button.expand { font: 10px var(--mono); color: var(--dim); background: none;
  border: 1px solid var(--rule); border-radius: 3px; padding: 1px 6px; cursor: pointer; }
button.expand:hover { color: var(--fg); border-color: var(--dim); }

pre.hunk { grid-area: code; margin: 0; background: var(--panel); border-radius: 5px;
  padding: 8px 10px; overflow-x: auto; font: 12px/1.55 var(--mono); }
pre.hunk code { display: block; }
.hunk .lineno { color: var(--dim); user-select: none; display: inline-block;
  width: 3.2em; text-align: right; margin-right: 12px; }

.note { grid-area: note; display: flex; gap: 8px; align-items: flex-start; padding: 8px 0; }
.badge { flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: var(--accent); color: var(--bg); font: 700 11px var(--mono); }
.note-text { font-size: 12.5px; line-height: 1.45; }

.edge { color: var(--accent); font: 11px var(--mono); white-space: pre;
  padding: 2px 0 2px 4px; }

.branch { border-left: 2px dashed var(--err); margin: 6px 0 10px 24px; padding-left: 16px; }
.branch-condition { color: var(--err); font: 11px var(--mono); padding: 2px 0 6px; }
.branch .badge { background: var(--err); }

@media (max-width: 820px) {
  .step { grid-template-columns: 1fr; grid-template-areas: "header" "code" "note"; }
}
`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/render.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/client/render.ts src/viewer/client/styles.ts tests/render.test.ts
git commit -m "feat: render the reading path with branches and margin notes"
```

---

### Task 8: Client loading, expansion and highlighting

**Files:**
- Create: `src/viewer/client/hunks.ts`
- Create: `src/viewer/client/main.ts`
- Test: `tests/hunks.test.ts`

**Interfaces:**
- Consumes: `renderLayer`, `STYLES` (Task 7); `/api/context` and `/ws` (Tasks 5-6)
- Produces:
  - `type ContextResponse = { file: string; start_line: number; end_line: number; lines: string[] }`
  - `fillHunk(section: HTMLElement, body: ContextResponse, doc: Document): void` — writes numbered lines into the section's `<code>`, clears `data-pending`, and records the shown range on the section
  - `expandedRange(section: HTMLElement): { start: number; end: number }` — the range to request next, widening from whatever is currently shown
  - `main.ts` has no exports; it is the bundle entry.

- [ ] **Step 1: Write the failing test**

Create `tests/hunks.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { fillHunk, expandedRange } from "../src/viewer/client/hunks.js";
import { renderLayer } from "../src/viewer/client/render.js";
import type { NumberedLayer } from "../src/layer/number.js";

const layer: NumberedLayer = {
  title: "T",
  steps: [
    { n: "1", file: "a.ts", start_line: 9, end_line: 11, first_line_text: "x", note: "n" },
  ],
};

const section = (): HTMLElement =>
  renderLayer(layer, document).querySelector("section.step") as HTMLElement;

describe("fillHunk", () => {
  it("writes one line element per source line with its number", () => {
    const s = section();
    fillHunk(s, { file: "a.ts", start_line: 9, end_line: 11, lines: ["one", "two", "three"] }, document);
    const nums = [...s.querySelectorAll(".lineno")].map((n) => n.textContent);
    expect(nums).toEqual(["9", "10", "11"]);
  });

  it("clears the pending flag", () => {
    const s = section();
    fillHunk(s, { file: "a.ts", start_line: 9, end_line: 9, lines: ["one"] }, document);
    expect(s.querySelector("code")?.dataset.pending).toBeUndefined();
  });

  it("records the shown range on the section", () => {
    const s = section();
    fillHunk(s, { file: "a.ts", start_line: 4, end_line: 6, lines: ["a", "b", "c"] }, document);
    expect(s.dataset.shownStart).toBe("4");
    expect(s.dataset.shownEnd).toBe("6");
  });

  it("replaces previous content rather than appending", () => {
    const s = section();
    fillHunk(s, { file: "a.ts", start_line: 9, end_line: 9, lines: ["one"] }, document);
    fillHunk(s, { file: "a.ts", start_line: 8, end_line: 9, lines: ["zero", "one"] }, document);
    expect(s.querySelectorAll(".lineno")).toHaveLength(2);
  });

  it("does not interpret source as markup", () => {
    const s = section();
    fillHunk(s, { file: "a.ts", start_line: 1, end_line: 1, lines: ["<script>x</script>"] }, document);
    expect(s.querySelector("script")).toBeNull();
    expect(s.textContent).toContain("<script>x</script>");
  });
});

describe("expandedRange", () => {
  it("uses the anchor range before anything is shown", () => {
    expect(expandedRange(section())).toEqual({ start: 9, end: 11 });
  });

  it("widens from the currently shown range", () => {
    const s = section();
    fillHunk(s, { file: "a.ts", start_line: 4, end_line: 20, lines: [] }, document);
    expect(expandedRange(s)).toEqual({ start: 4, end: 20 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hunks.test.ts`
Expected: FAIL — cannot resolve `../src/viewer/client/hunks.js`.

- [ ] **Step 3: Write the hunk filler**

Create `src/viewer/client/hunks.ts`:

```ts
export interface ContextResponse {
  file: string;
  start_line: number;
  end_line: number;
  lines: string[];
}

/** Replace a step's code block with numbered source lines. */
export function fillHunk(section: HTMLElement, body: ContextResponse, doc: Document): void {
  const code = section.querySelector("code");
  if (!code) return;

  code.textContent = "";
  body.lines.forEach((line, i) => {
    const row = doc.createElement("div");
    row.className = "line";

    const num = doc.createElement("span");
    num.className = "lineno";
    num.textContent = String(body.start_line + i);

    const text = doc.createElement("span");
    text.className = "linetext";
    text.textContent = line;

    row.append(num, text);
    code.append(row);
  });

  delete code.dataset.pending;
  section.dataset.shownStart = String(body.start_line);
  section.dataset.shownEnd = String(body.end_line);
}

/**
 * The range to ask the server for next. The server widens by CONTEXT_LINES on
 * both sides, so passing back what is already shown is what makes each click
 * reveal more.
 */
export function expandedRange(section: HTMLElement): { start: number; end: number } {
  const start = Number(section.dataset.shownStart ?? section.dataset.start);
  const end = Number(section.dataset.shownEnd ?? section.dataset.end);
  return { start, end };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hunks.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the bundle entry**

Create `src/viewer/client/main.ts`:

```ts
import hljs from "highlight.js";
import type { NumberedLayer } from "../../layer/number.js";
import { renderLayer } from "./render.js";
import { STYLES } from "./styles.js";
import { fillHunk, expandedRange, type ContextResponse } from "./hunks.js";

const app = document.getElementById("app") as HTMLElement;

const style = document.createElement("style");
style.textContent = STYLES;
document.head.append(style);

const hljsTheme = document.createElement("link");
hljsTheme.rel = "stylesheet";
hljsTheme.href = "/client/hljs.css";
document.head.append(hljsTheme);

async function fetchContext(file: string, start: number, end: number): Promise<ContextResponse | null> {
  const qs = new URLSearchParams({ file, start: String(start), end: String(end) });
  const res = await fetch(`/api/context?${qs}`);
  return res.ok ? ((await res.json()) as ContextResponse) : null;
}

function highlight(section: HTMLElement): void {
  const file = section.dataset.file ?? "";
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const language = hljs.getLanguage(ext) ? ext : null;
  for (const text of section.querySelectorAll<HTMLElement>(".linetext")) {
    const source = text.textContent ?? "";
    text.innerHTML = language
      ? hljs.highlight(source, { language, ignoreIllegals: true }).value
      : escapeHtml(source);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function loadSection(section: HTMLElement, range: { start: number; end: number }): Promise<void> {
  const body = await fetchContext(section.dataset.file ?? "", range.start, range.end);
  if (!body) {
    const code = section.querySelector("code");
    if (code) code.textContent = "(could not read this file)";
    return;
  }
  fillHunk(section, body, document);
  highlight(section);
}

function draw(layer: NumberedLayer): void {
  app.replaceChildren(renderLayer(layer, document));

  for (const section of app.querySelectorAll<HTMLElement>("section.step")) {
    const start = Number(section.dataset.start);
    const end = Number(section.dataset.end);
    // The server pads by CONTEXT_LINES, so ask for the exact anchor range
    // first and let the expander widen from there.
    void fetchContext(section.dataset.file ?? "", start, end).then((body) => {
      if (!body) return;
      const exact = body.lines.slice(start - body.start_line, end - body.start_line + 1);
      fillHunk(section, { ...body, start_line: start, end_line: end, lines: exact }, document);
      highlight(section);
    });

    section.querySelector("button.expand")?.addEventListener("click", () => {
      void loadSection(section, expandedRange(section));
    });
  }
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data as string) as { type: string; layer: NumberedLayer };
    if (msg.type === "layer") draw(msg.layer);
  });
  ws.addEventListener("close", () => setTimeout(connect, 1000));
}

void fetch("/api/layer")
  .then((r) => r.json() as Promise<{ layer: NumberedLayer | null }>)
  .then(({ layer }) => {
    if (layer) draw(layer);
  });

connect();
```

- [ ] **Step 6: Add the highlight.js theme to the build**

Add to `package.json` scripts, replacing `build:client`:

```json
    "build:client": "esbuild src/viewer/client/main.ts --bundle --format=esm --outfile=dist/client/main.js && cp src/viewer/client/index.html dist/client/index.html && cp node_modules/highlight.js/styles/atom-one-dark.css dist/client/hljs.css",
```

Then add the `/client/hljs.css` route to `handle()` in `src/viewer/server.ts`, alongside the existing `/client/main.js` case:

```ts
    case "/client/hljs.css":
      sendFile(res, join(opts.assetDir, "hljs.css"), "text/css; charset=utf-8");
      return;
```

- [ ] **Step 7: Verify the bundle builds**

Run: `npm run build`
Expected: exits 0; `dist/client/main.js`, `dist/client/index.html` and `dist/client/hljs.css` all exist.

- [ ] **Step 8: Commit**

```bash
git add src/viewer/client/hunks.ts src/viewer/client/main.ts src/viewer/server.ts package.json tests/hunks.test.ts
git commit -m "feat: load, expand and syntax-highlight hunks in the viewer"
```

---

### Task 9: MCP server and `emit_layer`

**Files:**
- Create: `src/mcp/emit.ts`
- Create: `src/mcp/server.ts`
- Create: `src/index.ts`
- Test: `tests/emit.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-6
- Produces:
  - `type EmitResult = { ok: true; url: string; step_count: number } | { ok: false; bad_anchors: BadAnchor[] }`
  - `createEmitter(opts: { root: string; assetDir: string; store: LayerStore; ensureViewer: () => Promise<ViewerHandle> }): (input: unknown) => Promise<EmitResult>`
  - `startMcpServer(opts: { root: string; assetDir: string }): Promise<void>` — wires stdio transport and lazily starts the viewer on first successful emit
  - `src/index.ts` — CLI entry, parses `--root`, resolves `assetDir` to the directory holding the built client, calls `startMcpServer`

The tool description matters as much as the code — it is the only instruction the agent gets. Register it with the text given in Step 5.

- [ ] **Step 1: Write the failing test**

Create `tests/emit.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayerStore } from "../src/viewer/state.js";
import { startViewer, type ViewerHandle } from "../src/viewer/server.js";
import { createEmitter } from "../src/mcp/emit.js";

let root: string;
let assetDir: string;
let viewer: ViewerHandle;
let store: LayerStore;
let emit: (input: unknown) => Promise<any>;
let viewerStarts = 0;

const step = {
  file: "src/a.ts",
  start_line: 2,
  end_line: 2,
  first_line_text: "bravo",
  note: "the note",
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "marginalia-emit-"));
  assetDir = mkdtempSync(join(tmpdir(), "marginalia-emit-assets-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "alpha\nbravo\ncharlie\n");
  writeFileSync(join(assetDir, "index.html"), "<!doctype html>");
  writeFileSync(join(assetDir, "main.js"), "");

  store = new LayerStore();
  emit = createEmitter({
    root,
    assetDir,
    store,
    ensureViewer: async () => {
      if (!viewer) {
        viewerStarts++;
        viewer = await startViewer({ root, store, assetDir, port: 0 });
      }
      return viewer;
    },
  });
});

afterAll(async () => {
  await viewer?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(assetDir, { recursive: true, force: true });
});

describe("emit_layer", () => {
  it("publishes a valid layer and returns a url", async () => {
    const r = await emit({ title: "T", steps: [step] });
    expect(r.ok).toBe(true);
    expect(r.url).toMatch(/^http:\/\/localhost:\d+\/\?key=[0-9a-f]{64}$/);
    expect(r.step_count).toBe(1);
  });

  it("stores the layer with server-assigned numbers", async () => {
    await emit({ title: "T", steps: [step, { ...step, note: "second" }] });
    expect(store.get()?.steps.map((s) => s.n)).toEqual(["1", "2"]);
  });

  it("reuses one viewer across emits", async () => {
    await emit({ title: "T", steps: [step] });
    await emit({ title: "T", steps: [step] });
    expect(viewerStarts).toBe(1);
  });

  it("refuses to publish when an anchor is wrong", async () => {
    const before = store.get();
    const r = await emit({ title: "bad", steps: [{ ...step, first_line_text: "zulu" }] });
    expect(r.ok).toBe(false);
    expect(r.bad_anchors[0]).toMatchObject({ index: 0, file: "src/a.ts", expected: "zulu" });
    expect(store.get()).toBe(before);
  });

  it("returns a validation error for a malformed layer", async () => {
    const r = await emit({ title: "T", steps: [{ ...step, end_line: 1, start_line: 9 }] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("end_line");
  });

  it("returns a validation error for depth-2 branches", async () => {
    const nested = { ...step, branches: [{ condition: "inner", steps: [step] }] };
    const r = await emit({
      title: "T",
      steps: [{ ...step, branches: [{ condition: "outer", steps: [nested] }] }],
    });
    expect(r.ok).toBe(false);
  });

  it("corrects drift silently and publishes", async () => {
    const r = await emit({ title: "T", steps: [{ ...step, start_line: 3, end_line: 3 }] });
    expect(r.ok).toBe(true);
    expect(store.get()?.steps[0]?.start_line).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/emit.test.ts`
Expected: FAIL — cannot resolve `../src/mcp/emit.js`.

- [ ] **Step 3: Write the emitter**

Create `src/mcp/emit.ts`:

```ts
import { LayerInputSchema } from "../layer/schema.js";
import { resolveLayerAnchors, type BadAnchor } from "../layer/anchor.js";
import { assignNumbers } from "../layer/number.js";
import type { LayerStore } from "../viewer/state.js";
import type { ViewerHandle } from "../viewer/server.js";

export type EmitResult =
  | { ok: true; url: string; step_count: number }
  | { ok: false; error: string; bad_anchors?: BadAnchor[] };

export interface EmitterOptions {
  root: string;
  assetDir: string;
  store: LayerStore;
  ensureViewer: () => Promise<ViewerHandle>;
}

export function createEmitter(opts: EmitterOptions): (input: unknown) => Promise<EmitResult> {
  return async (input: unknown): Promise<EmitResult> => {
    const parsed = LayerInputSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `invalid layer: ${issues}` };
    }

    const anchored = resolveLayerAnchors(opts.root, parsed.data);
    if (!anchored.ok) {
      return {
        ok: false,
        error:
          "one or more anchors did not match the file on disk; fix first_line_text or the line numbers and call emit_layer again",
        bad_anchors: anchored.bad_anchors,
      };
    }

    const numbered = assignNumbers(anchored.layer);
    const viewer = await opts.ensureViewer();
    opts.store.set(numbered);

    const branchSteps = numbered.steps.reduce(
      (acc, s) => acc + (s.branches?.reduce((a, b) => a + b.steps.length, 0) ?? 0),
      0,
    );
    return { ok: true, url: viewer.url, step_count: numbered.steps.length + branchSteps };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/emit.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the MCP server**

Create `src/mcp/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { layerInputShape } from "../layer/schema.js";
import { LayerStore } from "../viewer/state.js";
import { startViewer, type ViewerHandle } from "../viewer/server.js";
import { createEmitter } from "./emit.js";

const DESCRIPTION = `Render a numbered, annotated reading path over this repository's source in the user's browser. Nothing on disk is modified.

Use this instead of explaining code in prose. Each step is a short real excerpt plus the one thing worth saying about it; the viewer shows the code, so do not restate what the code plainly says.

Rules:
- Order steps the way control flow actually visits them, across files.
- first_line_text must be the exact text of the line at start_line. It is checked against disk, and a mismatch rejects the whole layer.
- Keep excerpts tight (3-12 lines). The reader can expand for surrounding context.
- Use edge_label to say how flow reaches the next step, e.g. "calls verify()".
- Use branches for error paths and conditionals. One level only.
- Do not number the steps yourself.`;

export async function startMcpServer(opts: { root: string; assetDir: string }): Promise<void> {
  const store = new LayerStore();
  let viewer: ViewerHandle | null = null;

  const emit = createEmitter({
    root: opts.root,
    assetDir: opts.assetDir,
    store,
    ensureViewer: async () => {
      viewer ??= await startViewer({ root: opts.root, store, assetDir: opts.assetDir });
      return viewer;
    },
  });

  const server = new McpServer({ name: "marginalia", version: "0.1.0" });

  server.registerTool(
    "emit_layer",
    { title: "Emit annotation layer", description: DESCRIPTION, inputSchema: layerInputShape },
    async (args) => {
      const result = await emit(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: !result.ok,
      };
    },
  );

  await server.connect(new StdioServerTransport());
}
```

Create `src/index.ts`:

```ts
#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "./mcp/server.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = resolve(argValue("--root") ?? process.cwd());
const assetDir = join(dirname(fileURLToPath(import.meta.url)), "client");

startMcpServer({ root, assetDir }).catch((err) => {
  process.stderr.write(`marginalia failed to start: ${String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Verify it builds and the suite is green**

Run: `npm run build && npx vitest run`
Expected: build exits 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/emit.ts src/mcp/server.ts src/index.ts tests/emit.test.ts
git commit -m "feat: expose emit_layer over MCP stdio"
```

---

### Task 10: End-to-end test and README

**Files:**
- Create: `tests/e2e.test.ts`
- Create: `README.md`
- Test: `tests/e2e.test.ts`

**Interfaces:**
- Consumes: the built `dist/index.js`
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

Create `tests/e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let root: string;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "marginalia-e2e-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "handler.ts"),
    ["import { verify } from './auth.js';", "", "export function handle(req: Request) {", "  const s = verify(req);", "  return s;", "}", ""].join("\n"),
  );

  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist", "index.js"), "--root", root],
    }),
  );
}, 30_000);

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (args: unknown) => {
  const res = await client.callTool({ name: "emit_layer", arguments: args as Record<string, unknown> });
  const first = (res.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(first!.text);
};

describe("end to end", () => {
  it("advertises emit_layer", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("emit_layer");
  });

  it("publishes a layer reachable over http with server numbering", async () => {
    const result = await call({
      title: "How is a request handled?",
      steps: [
        {
          file: "src/handler.ts",
          start_line: 3,
          end_line: 5,
          first_line_text: "export function handle(req: Request) {",
          note: "Entry point.",
          edge_label: "calls verify()",
          branches: [
            {
              condition: "if verify throws",
              steps: [
                {
                  file: "src/handler.ts",
                  start_line: 4,
                  end_line: 4,
                  first_line_text: "  const s = verify(req);",
                  note: "Propagates straight out.",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.step_count).toBe(2);

    const res = await fetch(new URL("/api/layer", result.url).toString() + `?key=${new URL(result.url).searchParams.get("key")}`);
    expect(res.status).toBe(200);
    const { layer } = await res.json();
    expect(layer.title).toBe("How is a request handled?");
    expect(layer.steps[0].n).toBe("1");
    expect(layer.steps[0].branches[0].steps[0].n).toBe("1a");
  });

  it("rejects a bad anchor without publishing", async () => {
    const result = await call({
      title: "wrong",
      steps: [
        {
          file: "src/handler.ts",
          start_line: 3,
          end_line: 3,
          first_line_text: "this line does not exist",
          note: "n",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.bad_anchors[0].reason).toBe("not_found");
  });
});
```

- [ ] **Step 2: Build, then run the test**

Run: `npm run build && npx vitest run tests/e2e.test.ts`
Expected: PASS, 3 tests. If the transport times out, confirm `dist/index.js` exists and writes nothing to stdout other than MCP frames — any stray `console.log` in the server corrupts the stream.

- [ ] **Step 3: Write the README**

Create `README.md`:

````markdown
# marginalia

Notes on your code, not next to it.

Ask an agent how something works and you get a wall of prose you then have to
match back against the source by hand. marginalia gives the agent somewhere
better to put the answer: a numbered reading path over your real files, in the
order control flow visits them, with each note in the margin beside the code it
describes. Nothing in your repository is modified.

Layers are ephemeral by design. You ask a question, read the answer against live
source, and throw it away. Nothing to commit, nothing to keep up to date.

## Install

```bash
npm install -g marginalia
```

## Use with Claude Code

```bash
claude mcp add marginalia -- marginalia --root .
```

Then just ask:

> show me how a request gets authenticated

The agent reads the code, emits a layer, and a browser tab opens with the
annotated path.

## How it works

marginalia does no retrieval and makes no LLM calls. It exposes one MCP tool,
`emit_layer`, that takes a title and a list of steps — each a file, a line
range, the exact text of the first line, and one note. The agent supplies those;
marginalia verifies every anchor against disk, numbers the steps, and renders.

If an anchor does not match, the layer is not published and the agent is told
which steps are wrong so it can retry. A confident note beside the wrong snippet
is worse than no tool at all.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | `process.cwd()` | Directory all step paths resolve inside. Paths escaping it are rejected. |

## Development

```bash
npm install
npm run build
npm test
```
````

- [ ] **Step 4: Full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e.test.ts README.md
git commit -m "test: add end-to-end coverage and write the README"
```

---

## Self-Review Notes

Checked against the spec:

- **Ephemeral layers** — `LayerStore` holds one layer in memory, nothing is written to the repo (Task 5).
- **Agent as retrieval engine** — no LLM dependency anywhere; `emit_layer` is the entire tool surface (Task 9).
- **`emit_layer` ok / bad_anchors contract** — Task 9, tested in Tasks 9 and 10.
- **Schema, numbering rule, structural depth cap** — Tasks 2 and 3.
- **Anchor resolution with ±40 search and self-correction** — Task 4.
- **Root guard including symlinks, applied to expansion too** — Tasks 1 and 5.
- **Session-key gating on HTTP and WebSocket** — Tasks 5 and 6.
- **Reading-path layout, spine plus indented branches, margin notes** — Task 7.
- **±20-line expansion** — `CONTEXT_LINES` in Task 5, wired in Task 8.
- **One layer live at a time, replaced over WebSocket** — Task 6.
- **Test list from the spec** — anchor resolver (Task 4), schema (Task 2), path traversal (Tasks 1, 5), render (Task 7), e2e (Task 10).

Deferred exactly as the spec says: pinning, tree-sitter, `.tour` export, the Neovim renderer, multiple simultaneous layers, in-browser editing.
