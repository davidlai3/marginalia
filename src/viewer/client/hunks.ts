export interface ContextResponse {
  file: string;
  start_line: number;
  end_line: number;
  lines: string[];
}

/** Replace a step's code block with numbered source lines. */
export function fillHunk(section: HTMLElement, body: ContextResponse, doc: Document): void {
  const code = section.querySelector("code");
  if (!code) return;

  code.textContent = "";
  body.lines.forEach((line, i) => {
    const row = doc.createElement("div");
    row.className = "line";

    const num = doc.createElement("span");
    num.className = "lineno";
    num.textContent = String(body.start_line + i);

    const text = doc.createElement("span");
    text.className = "linetext";
    text.textContent = line;

    row.append(num, text);
    code.append(row);
  });

  delete code.dataset.pending;
  section.dataset.shownStart = String(body.start_line);
  section.dataset.shownEnd = String(body.end_line);
}

/** Lines each expand click reveals. */
export const CONTEXT_LINES = 10;

export interface Range {
  start: number;
  end: number;
}

/** The anchor's own range — what "reset" goes back to. Never mutated. */
export function anchorRange(section: HTMLElement): Range {
  return { start: Number(section.dataset.start), end: Number(section.dataset.end) };
}

/** What the section currently shows, falling back to the anchor before first fill. */
export function shownRange(section: HTMLElement): Range {
  return {
    start: Number(section.dataset.shownStart ?? section.dataset.start),
    end: Number(section.dataset.shownEnd ?? section.dataset.end),
  };
}

/** The range an expand control should request. */
export function rangeFor(section: HTMLElement, dir: string): Range {
  const shown = shownRange(section);
  if (dir === "up") return { start: Math.max(1, shown.start - CONTEXT_LINES), end: shown.end };
  if (dir === "down") return { start: shown.start, end: shown.end + CONTEXT_LINES };
  return anchorRange(section);
}
