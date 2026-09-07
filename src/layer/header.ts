/**
 * The declaration line a hunk sits inside — what git shows after `@@` and what
 * a reader needs to know which function they are looking at when the excerpt
 * starts mid-body.
 *
 * Language-agnostic and deliberately shallow: walk up, keep only lines that
 * are less indented than everything seen so far, and return the first that
 * reads as a declaration rather than a control-flow block.
 */
export interface Header {
  line: number;
  text: string;
}

/** Punctuation-only lines (a lone brace, `):`) carry no indentation signal. */
const NOISE = /^[\s{}()\[\];,]*$/;

const CONTROL = /^\s*(?:if|for|while|switch|catch|else|elif|do|try|match|when|case|with|using|return|throw|yield)\b/;

const DECLARING = /\b(?:class|struct|interface|enum|impl|trait|module|namespace|def|fn|func|function|sub|proc|type)\b/;

/** A signature line: ends in its parameter list, optionally with `{`, `:` or a return type. */
const SIGNATURE = /\)[^()]*[{:]?\s*$/;

const indentOf = (s: string): number => s.length - s.trimStart().length;

/** Innermost declaration enclosing `start` (1-based), or null. */
export function enclosingHeader(lines: string[], start: number): Header | null {
  let minIndent = indentOf(lines[start - 1] ?? "");

  for (let i = start - 2; i >= 0; i--) {
    const text = lines[i] as string;
    if (NOISE.test(text)) continue;

    const indent = indentOf(text);
    if (indent >= minIndent) continue;
    minIndent = indent;

    if (CONTROL.test(text)) continue;
    if (DECLARING.test(text) || SIGNATURE.test(text)) return { line: i + 1, text };
  }
  return null;
}
