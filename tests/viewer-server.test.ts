import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayerStore } from "../src/viewer/state.js";
import { startViewer, type ViewerHandle } from "../src/viewer/server.js";

let root: string;
let assetDir: string;
let viewer: ViewerHandle;
let base: string;

const layer = {
  title: "T",
  steps: [
    { n: "1", file: "src/a.ts", start_line: 2, end_line: 2, first_line_text: "bravo", note: "hi" },
  ],
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sidenote-viewer-"));
  assetDir = mkdtempSync(join(tmpdir(), "sidenote-assets-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "a.ts"),
    Array.from({ length: 100 }, (_, i) => (i === 1 ? "bravo" : `line ${i + 1}`)).join("\n"),
  );
  writeFileSync(join(assetDir, "index.html"), "<!doctype html><title>sidenote</title>");
  writeFileSync(join(assetDir, "main.js"), "export const x = 1;");

  const store = new LayerStore();
  store.set(layer);
  viewer = await startViewer({ root, store, assetDir, port: 0 });
  base = `http://127.0.0.1:${viewer.port}`;
});

afterAll(async () => {
  await viewer.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(assetDir, { recursive: true, force: true });
});

describe("viewer server auth", () => {
  it("rejects a request with no key", async () => {
    expect((await fetch(`${base}/api/layer`)).status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    expect((await fetch(`${base}/api/layer?key=wrong`)).status).toBe(401);
  });

  it("accepts the session key", async () => {
    const res = await fetch(`${base}/api/layer?key=${viewer.key}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ layer });
  });

  it("accepts the key from a cookie", async () => {
    const res = await fetch(`${base}/api/layer`, { headers: { cookie: `sn_key=${viewer.key}` } });
    expect(res.status).toBe(200);
  });

  it("sets the cookie when the key arrives in the query", async () => {
    const res = await fetch(`${base}/?key=${viewer.key}`);
    expect(res.headers.get("set-cookie")).toContain(`sn_key=${viewer.key}`);
  });
});

describe("GET /api/context", () => {
  const ctx = (qs: string) => fetch(`${base}/api/context?key=${viewer.key}&${qs}`);

  it("returns exactly the range asked for", async () => {
    const res = await ctx("file=src/a.ts&start=50&end=51");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.start_line).toBe(50);
    expect(body.end_line).toBe(51);
    expect(body.lines).toHaveLength(2);
  });

  it("returns the right lines, not just the right count", async () => {
    const body = await (await ctx("file=src/a.ts&start=3&end=4")).json();
    expect(body.lines).toEqual(["line 3", "line 4"]);
  });

  it("clamps an end past the last line", async () => {
    const body = await (await ctx("file=src/a.ts&start=99&end=140")).json();
    expect(body.start_line).toBe(99);
    expect(body.end_line).toBe(100);
    expect(body.lines).toHaveLength(2);
  });

  it("rejects a path outside the root", async () => {
    expect((await ctx("file=../escape.ts&start=1&end=1")).status).toBe(400);
  });

  it("rejects a non-numeric range", async () => {
    expect((await ctx("file=src/a.ts&start=abc&end=1")).status).toBe(400);
  });

  it("404s a missing file", async () => {
    expect((await ctx("file=src/nope.ts&start=1&end=1")).status).toBe(404);
  });

  it("404s a range starting beyond the end of the file", async () => {
    expect((await ctx("file=src/a.ts&start=1000&end=1005")).status).toBe(404);
  });
});

describe("static assets", () => {
  it("serves index.html at the root", async () => {
    const res = await fetch(`${base}/?key=${viewer.key}`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("sidenote");
  });

  it("serves the client bundle", async () => {
    const res = await fetch(`${base}/client/main.js?key=${viewer.key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });
});
