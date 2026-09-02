export const STYLES = `
:root {
  --bg: #1b1d23; --panel: #21252b; --fg: #d7dae0; --dim: #7c8598;
  --accent: #d19a66; --err: #e06c75; --rule: rgba(128,128,128,.25);
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.5 -apple-system, system-ui, sans-serif; }
.layer { max-width: 1100px; margin: 0 auto; padding: 32px 24px 96px; }
.layer-title { font-size: 20px; font-weight: 600; margin: 0 0 24px; }

.step { display: grid; grid-template-columns: 1.6fr 1fr; gap: 0 20px;
  grid-template-areas: "header ." "code note"; margin-bottom: 4px; }
.hunk-header-row { grid-area: header; display: flex; align-items: baseline;
  gap: 10px; padding: 6px 0 3px; }
.hunk-header { font: 11px var(--mono); color: var(--dim); letter-spacing: .02em; }
button.expand { font: 10px var(--mono); color: var(--dim); background: none;
  border: 1px solid var(--rule); border-radius: 3px; padding: 1px 6px; cursor: pointer; }
button.expand:hover { color: var(--fg); border-color: var(--dim); }

pre.hunk { grid-area: code; margin: 0; background: var(--panel); border-radius: 5px;
  padding: 8px 10px; overflow-x: auto; font: 12px/1.55 var(--mono); }
pre.hunk code { display: block; }
.hunk .lineno { color: var(--dim); user-select: none; display: inline-block;
  width: 3.2em; text-align: right; margin-right: 12px; }

.note { grid-area: note; display: flex; gap: 8px; align-items: flex-start; padding: 8px 0; }
.badge { flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: var(--accent); color: var(--bg); font: 700 11px var(--mono); }
.note-text { font-size: 12.5px; line-height: 1.45; }

.edge { color: var(--accent); font: 11px var(--mono); white-space: pre;
  padding: 2px 0 2px 4px; }

.branch { border-left: 2px dashed var(--err); margin: 6px 0 10px 24px; padding-left: 16px; }
.branch-condition { color: var(--err); font: 11px var(--mono); padding: 2px 0 6px; }
.branch .badge { background: var(--err); }

@media (max-width: 820px) {
  .step { grid-template-columns: 1fr; grid-template-areas: "header" "code" "note"; }
}
`;
