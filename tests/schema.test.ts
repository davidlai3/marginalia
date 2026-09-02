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
