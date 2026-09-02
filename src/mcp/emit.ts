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
