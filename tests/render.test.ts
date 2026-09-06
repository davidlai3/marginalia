// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderLayer } from "../src/viewer/client/render.js";
import type { NumberedLayer } from "../src/layer/number.js";

const layer: NumberedLayer = {
  title: "How does a request get authenticated?",
  steps: [
    {
      n: "1",
      file: "server/handler.rs",
      start_line: 9,
      end_line: 11,
      first_line_text: "  async fn handle(&self, r: Req) {",
      note: "Entry point.",
      edge_label: "calls verify()",
    },
    {
      n: "2",
      file: "auth/verify.rs",
      start_line: 41,
      end_line: 44,
      first_line_text: "pub fn verify(t: &str) -> Result<Session> {",
      note: "Two gates.",
      branches: [
        {
          condition: "if expired or bad signature",
          steps: [
            {
              n: "2a",
              file: "api/errors.rs",
              start_line: 22,
              end_line: 24,
              first_line_text: "impl From<AuthErr> for Resp {",
              note: "One 401 for everything.",
            },
          ],
        },
      ],
    },
  ],
};

const render = () => renderLayer(layer, document);

describe("renderLayer", () => {
  it("renders the title", () => {
    expect(render().querySelector(".layer-title")?.textContent).toBe(
      "How does a request get authenticated?",
    );
  });

  it("renders one section per step including branch steps", () => {
    expect(render().querySelectorAll("section.step")).toHaveLength(3);
  });

  it("labels each step with its server-assigned number", () => {
    const badges = [...render().querySelectorAll(".badge")].map((b) => b.textContent);
    expect(badges).toEqual(["1", "2", "2a"]);
  });

  it("puts file and line range in the hunk header", () => {
    expect(render().querySelector(".hunk-header")?.textContent).toBe("server/handler.rs:9-11");
  });

  it("carries anchor data attributes for the expander", () => {
    const first = render().querySelector("section.step") as HTMLElement;
    expect(first.dataset.file).toBe("server/handler.rs");
    expect(first.dataset.start).toBe("9");
    expect(first.dataset.end).toBe("11");
  });

  it("renders the note text", () => {
    expect(render().querySelector(".note-text")?.textContent).toBe("Entry point.");
  });

  it("renders an edge label after a step that has one", () => {
    expect(render().querySelector(".edge")?.textContent).toContain("calls verify()");
  });

  it("nests branch steps inside a branch container with its condition", () => {
    const branch = render().querySelector(".branch") as HTMLElement;
    expect(branch.dataset.condition).toBe("if expired or bad signature");
    expect(branch.querySelectorAll("section.step")).toHaveLength(1);
  });

  it("leaves each code block pending for the loader to fill", () => {
    const codes = render().querySelectorAll("code[data-pending='1']");
    expect(codes).toHaveLength(3);
  });

  it("gives every step up, down and reset controls", () => {
    const el = render();
    expect(el.querySelectorAll("button.expand")).toHaveLength(9);
    const first = el.querySelector("section.step") as HTMLElement;
    expect([...first.querySelectorAll<HTMLElement>("button.expand")].map((b) => b.dataset.dir)).toEqual([
      "up",
      "down",
      "reset",
    ]);
  });

  it("escapes rather than interprets note markup", () => {
    const evil: NumberedLayer = {
      title: "T",
      steps: [{ ...layer.steps[0]!, note: "<img src=x onerror=alert(1)>", branches: undefined }],
    };
    const el = renderLayer(evil, document);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".note-text")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
