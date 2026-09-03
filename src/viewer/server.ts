import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { resolveInRoot } from "../fs/root.js";
import { readFileLines } from "../layer/anchor.js";
import type { LayerStore } from "./state.js";

export const CONTEXT_LINES = 20;

export interface ViewerHandle {
  url: string;
  port: number;
  key: string;
  store: LayerStore;
  close(): Promise<void>;
}

export interface ViewerOptions {
  root: string;
  store: LayerStore;
  assetDir: string;
  host?: string;
  port?: number;
}

export async function startViewer(opts: ViewerOptions): Promise<ViewerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const key = randomBytes(32).toString("hex");

  const server = createServer((req, res) => {
    try {
      handle(req, res, opts, key);
    } catch {
      send(res, 500, { error: "internal" });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const port = (server.address() as AddressInfo).port;

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const ok =
      url.pathname === "/ws" &&
      (url.searchParams.get("key") === key || readCookie(req.headers.cookie, "mg_key") === key);
    if (!ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const current = opts.store.get();
      if (current) ws.send(JSON.stringify({ type: "layer", layer: current }));
      wss.emit("connection", ws, req);
    });
  });

  const unsubscribe = opts.store.subscribe((layer) => {
    const payload = JSON.stringify({ type: "layer", layer });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  });

  return {
    url: `http://localhost:${port}/?key=${key}`,
    port,
    key,
    store: opts.store,
    close: async () => {
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function handle(req: IncomingMessage, res: ServerResponse, opts: ViewerOptions, key: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryKey = url.searchParams.get("key");
  const cookieKey = readCookie(req.headers.cookie, "mg_key");

  if (queryKey !== key && cookieKey !== key) {
    send(res, 401, { error: "bad or missing session key" });
    return;
  }
  if (queryKey === key) {
    res.setHeader("Set-Cookie", `mg_key=${key}; Path=/; SameSite=Strict; HttpOnly`);
  }

  switch (url.pathname) {
    case "/":
      sendFile(res, join(opts.assetDir, "index.html"), "text/html; charset=utf-8");
      return;
    case "/client/main.js":
      sendFile(res, join(opts.assetDir, "main.js"), "text/javascript; charset=utf-8");
      return;
    case "/client/hljs.css":
      sendFile(res, join(opts.assetDir, "hljs.css"), "text/css; charset=utf-8");
      return;
    case "/api/layer":
      send(res, 200, { layer: opts.store.get() });
      return;
    case "/api/context":
      sendContext(res, opts.root, url);
      return;
    default:
      send(res, 404, { error: "not found" });
  }
}

function sendContext(res: ServerResponse, root: string, url: URL): void {
  const file = url.searchParams.get("file");
  const start = Number(url.searchParams.get("start"));
  const end = Number(url.searchParams.get("end"));

  if (!file || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    send(res, 400, { error: "file, start and end are required; start >= 1 and end >= start" });
    return;
  }

  let lines: string[];
  try {
    lines = readFileLines(resolveInRoot(root, file));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    send(res, code === "ENOENT" ? 404 : 400, { error: "cannot read file" });
    return;
  }

  const startLine = Math.max(1, start - CONTEXT_LINES);
  const endLine = Math.min(lines.length, end + CONTEXT_LINES);
  if (startLine > endLine) {
    send(res, 404, { error: "cannot read file" });
    return;
  }
  send(res, 200, {
    file,
    start_line: startLine,
    end_line: endLine,
    lines: lines.slice(startLine - 1, endLine),
  });
}

function sendFile(res: ServerResponse, path: string, contentType: string): void {
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch {
    send(res, 404, { error: "asset not found" });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
