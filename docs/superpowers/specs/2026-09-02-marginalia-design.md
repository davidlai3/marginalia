# marginalia — design

**Date:** 2026-09-02
**Status:** approved, ready for implementation planning

## Problem

Asking an LLM to explain a codebase produces a wall of prose. The reader then does the
expensive part by hand: matching each paragraph back to the source it describes. The
explanation and the code live in different panes, and the mapping between them exists
only in the reader's head.

marginalia moves the explanation onto the code. An agent emits numbered notes anchored
to real line ranges; a browser renders the annotated source. Nothing in the repository
is modified.

## Prior art and positioning

| Tool | What it does | Why it is not this |
| --- | --- | --- |
| [CodeTour](https://github.com/microsoft/codetour) (Microsoft, 4.6k★) | `.tours/*.tour` JSON, ordered steps anchored to file+line or a regex, played back as a stepper | A slideshow: one step visible at a time, VS Code only, schema carries VS Code concepts (`commands`, `view`, JS `when` expressions). Authored by hand. |
| [Tour de Code AI](https://github.com/Tour-de-Code-AI/Tour-de-Code-AI) (18★) | LLM generates CodeTour files via Repomix + chunked calls | Already shipped the "AI writes the tour" idea. 18 stars is the evidence that generation alone is not the valuable part. |
| [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki), [RepoWiki](https://github.com/he-yufeng/RepoWiki) | Auto-generated wiki, Mermaid diagrams, chat, per repo | Prose in one pane, code in another. This is the problem, not the fix. |
| Amp, Cursor | Mermaid diagrams in a chat panel | Diagram is detached from source; same matching cost. |

Unoccupied ground, and therefore the product thesis:

1. **All notes visible at once**, in the margin, against real syntax-highlighted source.
2. **Control flow rendered, not narrated** — steps connect, and forks are shown as forks.
3. **Ephemeral by design** (see below).

## Decision: layers are ephemeral

A layer is generated for one question, read, and discarded.

This is the load-bearing decision. Durable committed tours rot, and a stale tour is worse
than none — the most plausible explanation for why the existing AI-tour tools have not
found users. Because a layer lives minutes rather than months, anchoring can stay simple
and drift is a non-problem.

Consequence: no persistence, no re-anchoring UX, no review workflow, no merge conflicts.

## Decision: the agent is the retrieval engine

marginalia is an MCP server. It performs no retrieval, makes no LLM calls, owns no
prompts, and holds no API keys. The client agent has already read the code; marginalia is
a rendering target for what the agent concluded.

Accepted cost: the tool requires an MCP client and cannot be demoed standalone.

## Architecture

One TypeScript package (`npx marginalia`), two processes:

- **MCP server** — stdio, `@modelcontextprotocol/sdk`. Exposes one tool.
- **Viewer server** — localhost HTTP + WebSocket, spawned lazily on the first
  `emit_layer`. Serves the SPA, the layer, and expansion requests. The URL carries a
  session key; requests without it are rejected, so a stray tab or another host on the
  network cannot read repository source.

### Tool surface

```
emit_layer({ title, steps[] })
  → { ok: true,  url }
  → { ok: false, bad_anchors: [{ index, file, expected, found }] }
```

The failure branch carries the design weight. On any anchor mismatch the layer is not
published and the agent receives the specific failing steps, so it corrects them before a
human sees the page. A confidently-worded note beside the wrong snippet is worse than no
tool at all; this loop is what prevents it.

### Layer schema

```jsonc
{
  "title": "How does a request get authenticated?",
  "steps": [{
    "file": "server/handler.rs",
    "start_line": 9,
    "end_line": 11,
    "first_line_text": "  async fn handle(&self, r: Req) {",
    "note": "Entry point. Token pulled from the header, nothing validated yet.",
    "edge_label": "calls verify()",
    "branches": [{
      "condition": "if expired or bad signature",
      "steps": [ /* BranchStep: same shape, no `branches` key */ ]
    }]
  }]
}
```

Two deliberate constraints:

- **Numbering is assigned by the server**, never supplied by the agent. The spine is
  `1..n`; branch steps take their parent's number plus a letter (`2a`, `2b`). LLMs
  miscount, and nothing is gained by trusting them here.
- **Branch depth is capped structurally.** `BranchStep` is a distinct type with no
  `branches` field, so depth-2 nesting fails schema validation rather than a runtime
  check. Without a cap an agent will over-branch and produce an unreadable page.

### Anchor resolution

For each hunk:

1. Read the file, compare `first_line_text` against the line at `start_line`.
2. Exact match → accept.
3. Mismatch → search ±40 lines for the text. Exactly one hit → shift the whole range by
   the delta and accept silently.
4. Zero hits, or more than one → record in `bad_anchors`.

Paths in `file` are relative to the **root**: the directory the MCP server was launched
in, overridable with a `--root` flag. Every `file` must resolve inside it, symlinks
included. The same guard applies to expansion requests. The root need not be a git
repository.

### Viewer

Vanilla TypeScript plus highlight.js. No framework.

A single scrolling column: hunk, note in the right margin, edge label, next hunk.
Branches indent behind a dashed rule with their condition as the header.

`GET /api/context?file=&start=&end=` backs the expand controls: ±20 lines per click,
clamped to file bounds. This is the mitigation for the one real weakness of an assembled
view — an excerpt boundary the agent chose badly is one click from being fixed.

One layer is live at a time. A new `emit_layer` replaces it over the WebSocket and any
open tab updates in place.

## Testing

- **Anchor resolver** — exact match, shifted match, ambiguous match, missing text,
  clamping at end of file.
- **Schema** — depth-2 branches rejected, inverted line ranges rejected, missing
  fingerprint rejected.
- **Path traversal** — `../` segments, absolute paths, symlinks escaping the root.
- **Render** — fixture layer to DOM snapshot, covering spine, branch, and expansion.
- **End-to-end** — spawn the server, call `emit_layer`, assert `/api/layer` returns the
  layer with server-assigned numbering.

## Out of scope for v1

Pinning and persistence, tree-sitter semantic anchoring, `.tour` export, the Neovim
renderer, multiple simultaneous layers, in-browser note editing.

Each was considered and deferred. The schema is shaped so none of them are foreclosed:
semantic anchoring replaces the resolver behind a stable interface, and a Neovim renderer
is a second consumer of the same layer JSON.
