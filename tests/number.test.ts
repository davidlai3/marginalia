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
