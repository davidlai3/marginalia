import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let root: string;
let client: Client;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sidenote-e2e-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "handler.ts"),
    ["import { verify } from './auth.js';", "", "export function handle(req: Request) {", "  const s = verify(req);", "  return s;", "}", ""].join("\n"),
  );

  client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist", "index.js"), "--root", root],
    }),
  );
}, 30_000);

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (args: unknown) => {
  const res = await client.callTool({ name: "emit_layer", arguments: args as Record<string, unknown> });
  const first = (res.content as Array<{ type: string; text: string }>)[0];
  return JSON.parse(first!.text);
};

describe("end to end", () => {
  it("advertises emit_layer", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("emit_layer");
  });

  it("publishes a layer reachable over http with server numbering", async () => {
    const result = await call({
      title: "How is a request handled?",
      steps: [
        {
          file: "src/handler.ts",
          start_line: 3,
          end_line: 5,
          first_line_text: "export function handle(req: Request) {",
          note: "Entry point.",
          edge_label: "calls verify()",
          branches: [
            {
              condition: "if verify throws",
              steps: [
                {
                  file: "src/handler.ts",
                  start_line: 4,
                  end_line: 4,
                  first_line_text: "  const s = verify(req);",
                  note: "Propagates straight out.",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.step_count).toBe(2);

    const res = await fetch(new URL("/api/layer", result.url).toString() + `?key=${new URL(result.url).searchParams.get("key")}`);
    expect(res.status).toBe(200);
    const { layer } = await res.json();
    expect(layer.title).toBe("How is a request handled?");
    expect(layer.steps[0].n).toBe("1");
    expect(layer.steps[0].branches[0].steps[0].n).toBe("1a");
  });

  it("rejects a bad anchor without publishing", async () => {
    const result = await call({
      title: "wrong",
      steps: [
        {
          file: "src/handler.ts",
          start_line: 3,
          end_line: 3,
          first_line_text: "this line does not exist",
          note: "n",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.bad_anchors[0].reason).toBe("not_found");
  });
});
