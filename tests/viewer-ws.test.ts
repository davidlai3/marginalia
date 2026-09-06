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

// Attaches the "message" listener synchronously at construction time and buffers every
// frame that arrives. This matters because the on-connect snapshot can arrive bundled
// with the HTTP upgrade response on the same underlying socket read; `ws` redelivers
// that buffered data via `process.nextTick`, which Node drains before promise
// microtasks. A listener attached only after `await`-ing the "open" promise (a
// microtask continuation) is therefore structurally too late and can miss it — this
// buffering approach removes that ordering dependency instead of racing it.
const connect = (url: string): Promise<{ ws: WebSocket; next: () => Promise<any> }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const buffered: any[] = [];
    const waiting: ((msg: any) => void)[] = [];

    ws.on("message", (d) => {
      const msg = JSON.parse(String(d));
      const waiter = waiting.shift();
      if (waiter) waiter(msg);
      else buffered.push(msg);
    });

    const next = (): Promise<any> =>
      new Promise((res) => {
        const msg = buffered.shift();
        if (msg !== undefined) res(msg);
        else waiting.push(res);
      });

    ws.once("open", () => resolve({ ws, next }));
    ws.once("error", reject);
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sidenote-ws-root-"));
  assetDir = mkdtempSync(join(tmpdir(), "sidenote-ws-assets-"));
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
    await expect(connect(`ws://127.0.0.1:${viewer.port}/ws`)).rejects.toBeTruthy();
  });

  it("pushes the current layer on connect", async () => {
    store.set(mkLayer("first"));
    const { ws, next } = await connect(`ws://127.0.0.1:${viewer.port}/ws?key=${viewer.key}`);
    const msg = await next();
    expect(msg).toMatchObject({ type: "layer", layer: { title: "first" } });
    ws.close();
  });

  it("broadcasts a replacement layer to open sockets", async () => {
    const { ws, next } = await connect(`ws://127.0.0.1:${viewer.port}/ws?key=${viewer.key}`);
    await next(); // the on-connect snapshot
    const pending = next();
    store.set(mkLayer("second"));
    expect(await pending).toMatchObject({ type: "layer", layer: { title: "second" } });
    ws.close();
  });
});
