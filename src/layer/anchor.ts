import { readFileSync } from "node:fs";
import { resolveInRoot } from "../fs/root.js";
import type { LayerInput } from "./schema.js";

export const SEARCH_RADIUS = 40;

export type AnchorOk = { ok: true; start_line: number; end_line: number };
export type AnchorFail = {
  ok: false;
  reason: "not_found" | "ambiguous" | "missing_file";
  found: string | null;
};
export type AnchorResult = AnchorOk | AnchorFail;

export interface AnchorTarget {
  start_line: number;
  end_line: number;
  first_line_text: string;
}

const norm = (s: string): string => s.trim();

export function resolveAnchor(lines: string[], target: AnchorTarget): AnchorResult {
  const want = norm(target.first_line_text);
  const requested = target.start_line - 1;
  const atRequested = lines[requested];
  const span = target.end_line - target.start_line;

  const accept = (startIndex: number): AnchorOk => ({
    ok: true,
    start_line: startIndex + 1,
    end_line: Math.min(startIndex + 1 + span, lines.length),
  });

  if (atRequested !== undefined && norm(atRequested) === want) return accept(requested);

  const lo = Math.max(0, requested - SEARCH_RADIUS);
  const hi = Math.min(lines.length - 1, requested + SEARCH_RADIUS);
  const hits: number[] = [];
  for (let i = lo; i <= hi; i++) {
    if (norm(lines[i] as string) === want) hits.push(i);
  }

  const found = atRequested ?? null;
  if (hits.length === 1) return accept(hits[0] as number);
  if (hits.length > 1) return { ok: false, reason: "ambiguous", found };
  return { ok: false, reason: "not_found", found };
}

export function readFileLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n");
}

export interface BadAnchor {
  index: number;
  file: string;
  expected: string;
  found: string | null;
  reason: AnchorFail["reason"];
}

export type LayerAnchorResult =
  | { ok: true; layer: LayerInput }
  | { ok: false; bad_anchors: BadAnchor[] };

/**
 * Verify every anchor in the layer against disk. Small drift is corrected in
 * place; anything unresolvable is collected so the caller can hand it back to
 * the agent instead of publishing a wrong page.
 */
export function resolveLayerAnchors(root: string, layer: LayerInput): LayerAnchorResult {
  const bad: BadAnchor[] = [];
  const cache = new Map<string, string[] | null>();
  let index = 0;

  const linesFor = (file: string): string[] | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let lines: string[] | null;
    try {
      lines = readFileLines(resolveInRoot(root, file));
    } catch {
      lines = null;
    }
    cache.set(file, lines);
    return lines;
  };

  const fix = <T extends { file: string; start_line: number; end_line: number; first_line_text: string }>(
    step: T,
  ): T => {
    const i = index++;
    const lines = linesFor(step.file);
    if (lines === null) {
      bad.push({
        index: i,
        file: step.file,
        expected: step.first_line_text,
        found: null,
        reason: "missing_file",
      });
      return step;
    }
    const r = resolveAnchor(lines, step);
    if (!r.ok) {
      bad.push({
        index: i,
        file: step.file,
        expected: step.first_line_text,
        found: r.found,
        reason: r.reason,
      });
      return step;
    }
    return { ...step, start_line: r.start_line, end_line: r.end_line };
  };

  const steps = layer.steps.map((step) => {
    const fixed = fix(step);
    if (!fixed.branches) return fixed;
    return {
      ...fixed,
      branches: fixed.branches.map((b) => ({ ...b, steps: b.steps.map(fix) })),
    };
  });

  if (bad.length > 0) return { ok: false, bad_anchors: bad };
  return { ok: true, layer: { title: layer.title, steps } };
}
