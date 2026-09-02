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
