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
- Keep excerpts tight (3-12 lines). The reader can expand for surrounding context. Anything longer than 40 lines is truncated to 40.
- Use edge_label to say how flow reaches the next step, e.g. "calls verify()".
- Use branches for error paths and conditionals. One level only.
- Do not number the steps yourself.`;

/**
 * Wrap a viewer-starting thunk so concurrent callers share one in-flight
 * attempt instead of racing separate ones. The in-flight *promise* is
 * memoised, and the check-and-assign happens synchronously (no `await`
 * between them) so two calls that both arrive before `start()` resolves
 * still observe the same promise and land on the same handle.
 *
 * A rejection clears the memo before rethrowing: a failed startup should not
 * permanently brick emit_layer for the rest of the process, so both racing
 * callers see the rejection but the next call gets a fresh attempt instead
 * of forever replaying a stale rejection.
 */
export function memoizeViewerStart(
  start: () => Promise<ViewerHandle>,
): () => Promise<ViewerHandle> {
  let viewerPromise: Promise<ViewerHandle> | null = null;
  return (): Promise<ViewerHandle> => {
    if (viewerPromise === null) {
      viewerPromise = start().catch((err: unknown) => {
        viewerPromise = null;
        throw err;
      });
    }
    return viewerPromise;
  };
}

export async function startMcpServer(opts: { root: string; assetDir: string }): Promise<void> {
  const store = new LayerStore();

  const ensureViewer = memoizeViewerStart(() =>
    startViewer({ root: opts.root, store, assetDir: opts.assetDir }),
  );

  const emit = createEmitter({
    root: opts.root,
    assetDir: opts.assetDir,
    store,
    ensureViewer,
  });

  const server = new McpServer({ name: "sidenote", version: "0.1.0" });

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
