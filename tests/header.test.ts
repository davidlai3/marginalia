import { describe, it, expect } from "vitest";
import { enclosingHeader } from "../src/layer/header.js";

const at = (src: string, line: number) => enclosingHeader(src.trimStart().split("\n"), line);

describe("enclosingHeader", () => {
  it("finds the enclosing function of a mid-body hunk", () => {
    const src = `
function outer(a) {
  const x = 1;
  if (a) {
    return x;
  }
}`;
    expect(at(src, 4)).toEqual({ line: 1, text: "function outer(a) {" });
  });

  it("prefers the innermost declaration", () => {
    const src = `
class Store {
  def get(self, key):
    for k in key:
      print(k)`;
    expect(at(src, 4)).toEqual({ line: 2, text: "  def get(self, key):" });
  });

  it("skips a brace-on-its-own-line signature", () => {
    const src = `
static int foo(int x)
{
  return x;
}`;
    expect(at(src, 3)).toEqual({ line: 1, text: "static int foo(int x)" });
  });

  it("returns null at top level", () => {
    expect(at("import a from 'a';\nconst b = 1;", 2)).toBeNull();
  });

  it("ignores control flow blocks", () => {
    const src = `
if (a) {
  b();
}`;
    expect(at(src, 2)).toBeNull();
  });
});
