import type { NumberedBranch, NumberedBranchStep, NumberedLayer, NumberedStep } from "../../layer/number.js";

type AnyStep = NumberedStep | NumberedBranchStep;

export function renderLayer(layer: NumberedLayer, doc: Document): HTMLElement {
  const root = el(doc, "div", "layer");

  const title = el(doc, "h1", "layer-title");
  title.textContent = layer.title;
  root.append(title);

  layer.steps.forEach((step, i) => {
    root.append(renderStep(step, doc));
    if (step.branches) {
      for (const branch of step.branches) root.append(renderBranch(branch, doc));
    }
    const isLast = i === layer.steps.length - 1;
    if (step.edge_label && !isLast) root.append(renderEdge(step.edge_label, doc));
  });

  return root;
}

function renderBranch(branch: NumberedBranch, doc: Document): HTMLElement {
  const wrap = el(doc, "div", "branch");
  wrap.dataset.condition = branch.condition;

  const cond = el(doc, "div", "branch-condition");
  cond.textContent = `└─ ${branch.condition}`;
  wrap.append(cond);

  branch.steps.forEach((step, i) => {
    wrap.append(renderStep(step, doc));
    if (step.edge_label && i < branch.steps.length - 1) {
      wrap.append(renderEdge(step.edge_label, doc));
    }
  });
  return wrap;
}

function renderStep(step: AnyStep, doc: Document): HTMLElement {
  const section = doc.createElement("section");
  section.className = "step";
  section.dataset.n = step.n;
  section.dataset.file = step.file;
  section.dataset.start = String(step.start_line);
  section.dataset.end = String(step.end_line);

  const header = el(doc, "div", "hunk-header");
  header.textContent = `${step.file}:${step.start_line}-${step.end_line}`;

  const expand = doc.createElement("button");
  expand.className = "expand";
  expand.type = "button";
  expand.textContent = "expand";

  const headerRow = el(doc, "div", "hunk-header-row");
  headerRow.append(header, expand);

  const pre = doc.createElement("pre");
  pre.className = "hunk";
  const code = doc.createElement("code");
  code.dataset.pending = "1";
  pre.append(code);

  const note = el(doc, "div", "note");
  const badge = el(doc, "span", "badge");
  badge.textContent = step.n;
  const text = el(doc, "span", "note-text");
  text.textContent = step.note;
  note.append(badge, text);

  section.append(headerRow, pre, note);
  return section;
}

function renderEdge(label: string, doc: Document): HTMLElement {
  const edge = el(doc, "div", "edge");
  edge.textContent = `│ ${label}\n▼`;
  return edge;
}

function el(doc: Document, tag: string, className: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}
