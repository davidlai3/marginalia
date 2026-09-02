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
