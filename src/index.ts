#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcpServer } from "./mcp/server.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = resolve(argValue("--root") ?? process.cwd());
const assetDir = join(dirname(fileURLToPath(import.meta.url)), "client");

startMcpServer({ root, assetDir }).catch((err) => {
  process.stderr.write(`marginalia failed to start: ${String(err)}\n`);
  process.exit(1);
});
