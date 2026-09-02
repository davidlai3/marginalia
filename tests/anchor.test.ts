import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAnchor, resolveLayerAnchors, readFileLines } from "../src/layer/anchor.js";
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

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "marginalia-anchor-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "alpha\nbravo\ncharlie\ndelta\n");
  writeFileSync(join(root, "src", "b.ts"), "echo\nfoxtrot\n");
  writeFileSync(join(root, "src", "trailing-nl.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "src", "no-trailing-nl.ts"), "one\ntwo\nthree");
  writeFileSync(join(root, "src", "blank-last-line.ts"), "a\n\n");
  writeFileSync(join(root, "src", "empty.ts"), "");
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

describe("readFileLines", () => {
  it("does not produce a phantom trailing element for a file ending in a newline", () => {
    const result = readFileLines(join(root, "src", "trailing-nl.ts"));
    expect(result).toEqual(["one", "two", "three"]);
  });

  it("produces the same line count for a file not ending in a newline", () => {
    const result = readFileLines(join(root, "src", "no-trailing-nl.ts"));
    expect(result).toEqual(["one", "two", "three"]);
  });

  it("keeps a genuinely blank last line", () => {
    const result = readFileLines(join(root, "src", "blank-last-line.ts"));
    expect(result).toEqual(["a", ""]);
  });

  it("pins the behavior for an empty file", () => {
    // An empty file has no trailing newline to strip, so it falls through to
    // "".split("\n"), which yields a single empty-string element rather than
    // an empty array. Pinned here so a future change to this edge is
    // intentional rather than accidental.
    const result = readFileLines(join(root, "src", "empty.ts"));
    expect(result).toEqual([""]);
  });
});
