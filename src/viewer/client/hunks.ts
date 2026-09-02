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

/**
 * The range to ask the server for next. The server widens by CONTEXT_LINES on
 * both sides, so passing back what is already shown is what makes each click
 * reveal more.
 */
export function expandedRange(section: HTMLElement): { start: number; end: number } {
  const start = Number(section.dataset.shownStart ?? section.dataset.start);
  const end = Number(section.dataset.shownEnd ?? section.dataset.end);
  return { start, end };
}
