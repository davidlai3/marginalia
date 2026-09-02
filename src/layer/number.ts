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
