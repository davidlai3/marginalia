// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { fillHunk, rangeFor } from "../src/viewer/client/hunks.js";
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

describe("rangeFor", () => {
  const shown = (s: HTMLElement, start: number, end: number) =>
    fillHunk(s, { file: "a.ts", start_line: start, end_line: end, lines: [] }, document);

  it("expands up from the anchor before anything is shown", () => {
    expect(rangeFor(section(), "up")).toEqual({ start: 1, end: 11 });
  });

  it("expands up from the currently shown range, leaving the end alone", () => {
    const s = section();
    shown(s, 30, 40);
    expect(rangeFor(s, "up")).toEqual({ start: 20, end: 40 });
  });

  it("expands down from the currently shown range, leaving the start alone", () => {
    const s = section();
    shown(s, 30, 40);
    expect(rangeFor(s, "down")).toEqual({ start: 30, end: 50 });
  });

  it("clamps upward expansion at line 1 rather than going negative", () => {
    const s = section();
    shown(s, 4, 20);
    expect(rangeFor(s, "up")).toEqual({ start: 1, end: 20 });
  });

  it("resets to the anchor range however far it was expanded", () => {
    const s = section();
    shown(s, 1, 400);
    expect(rangeFor(s, "reset")).toEqual({ start: 9, end: 11 });
  });
});
