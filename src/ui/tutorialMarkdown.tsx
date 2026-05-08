import { type ReactNode } from "react";

// Tiny markdown subset for tutorial body copy. Supports:
//   - Paragraphs separated by a blank line
//   - `- ` bullet lists (every line in a contiguous run becomes a <li>)
//   - **bold** and *italic* inline
// Anything else is rendered as plain text. Designed for our hand-written
// tour stop bodies — not a general markdown engine. If a stop ever
// needs links, headings, or code spans, reach for a real library.

// Inline parse: walk the string, flush plain text between marker pairs
// into <strong>/<em>. Bold is matched first so a stray single `*` inside
// a bold span doesn't corrupt parsing. Unmatched markers are emitted
// as literal characters — better than crashing the helper.
export function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let nodeIdx = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  while (i < text.length) {
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        out.push(<strong key={`${keyPrefix}-b${nodeIdx++}`}>{text.slice(i + 2, end)}</strong>);
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1) {
        flush();
        out.push(<em key={`${keyPrefix}-i${nodeIdx++}`}>{text.slice(i + 1, end)}</em>);
        i = end + 1;
        continue;
      }
    }
    buf += text[i++];
  }
  flush();
  return out;
}

// Block parse: split by blank line into paragraph-or-list blocks. A
// block is a list iff every non-empty line starts with "- "; otherwise
// it's a paragraph (newlines inside paragraphs become spaces — we don't
// preserve hard wraps).
export function formatTutorialBody(body: string): ReactNode {
  const blocks = body.split(/\n\s*\n/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n").map(l => l.trimEnd()).filter(l => l.length > 0);
        if (lines.length === 0) return null;
        const isList = lines.every(l => l.startsWith("- "));
        if (isList) {
          return (
            <ul key={`b${bi}`} className="tutorial-helper-list">
              {lines.map((l, li) => (
                <li key={`b${bi}-l${li}`}>{renderInline(l.slice(2), `b${bi}-l${li}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={`b${bi}`} className="tutorial-helper-paragraph">
            {renderInline(lines.join(" "), `b${bi}`)}
          </p>
        );
      })}
    </>
  );
}
