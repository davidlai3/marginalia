import hljs from "highlight.js";
import type { NumberedLayer } from "../../layer/number.js";
import { renderLayer } from "./render.js";
import { STYLES } from "./styles.js";
import { fillHunk, expandedRange, type ContextResponse } from "./hunks.js";

const app = document.getElementById("app") as HTMLElement;

const style = document.createElement("style");
style.textContent = STYLES;
document.head.append(style);

const hljsTheme = document.createElement("link");
hljsTheme.rel = "stylesheet";
hljsTheme.href = "/client/hljs.css";
document.head.append(hljsTheme);

async function fetchContext(file: string, start: number, end: number): Promise<ContextResponse | null> {
  const qs = new URLSearchParams({ file, start: String(start), end: String(end) });
  const res = await fetch(`/api/context?${qs}`);
  return res.ok ? ((await res.json()) as ContextResponse) : null;
}

function highlight(section: HTMLElement): void {
  const file = section.dataset.file ?? "";
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const language = hljs.getLanguage(ext) ? ext : null;
  for (const text of Array.from(section.querySelectorAll<HTMLElement>(".linetext"))) {
    const source = text.textContent ?? "";
    text.innerHTML = language
      ? hljs.highlight(source, { language, ignoreIllegals: true }).value
      : escapeHtml(source);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function loadSection(section: HTMLElement, range: { start: number; end: number }): Promise<void> {
  const body = await fetchContext(section.dataset.file ?? "", range.start, range.end);
  if (!body) {
    const code = section.querySelector("code");
    if (code) code.textContent = "(could not read this file)";
    return;
  }
  fillHunk(section, body, document);
  highlight(section);
}

function draw(layer: NumberedLayer): void {
  app.replaceChildren(renderLayer(layer, document));

  for (const section of Array.from(app.querySelectorAll<HTMLElement>("section.step"))) {
    const start = Number(section.dataset.start);
    const end = Number(section.dataset.end);
    // The server pads by CONTEXT_LINES, so ask for the exact anchor range
    // first and let the expander widen from there.
    void fetchContext(section.dataset.file ?? "", start, end).then((body) => {
      if (!body) return;
      const exact = body.lines.slice(start - body.start_line, end - body.start_line + 1);
      fillHunk(section, { ...body, start_line: start, end_line: end, lines: exact }, document);
      highlight(section);
    });

    section.querySelector("button.expand")?.addEventListener("click", () => {
      void loadSection(section, expandedRange(section));
    });
  }
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data as string) as { type: string; layer: NumberedLayer };
    if (msg.type === "layer") draw(msg.layer);
  });
  ws.addEventListener("close", () => setTimeout(connect, 1000));
}

void fetch("/api/layer")
  .then((r) => r.json() as Promise<{ layer: NumberedLayer | null }>)
  .then(({ layer }) => {
    if (layer) draw(layer);
  });

connect();
