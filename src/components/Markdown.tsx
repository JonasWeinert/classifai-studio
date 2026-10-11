// A small Markdown renderer for imported documents: headings, paragraphs, bullet lists, tables,
// bold, italic and inline code. It builds React elements (no HTML injection), which is all the
// Word/PDF conversion produces.
import { Fragment, type ReactNode } from "react";

/** Does this text use Markdown structure worth rendering? */
export function looksLikeMarkdown(text: string) {
  return /^#{1,6} \S/m.test(text) || /\*\*[^*\n]+\*\*/.test(text) || /^\s*[-*] \S/m.test(text) || /^\|.*\|\s*$/m.test(text);
}

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|<br>)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${m.index}`;
    if (m[2]) out.push(<strong key={k}><em>{m[2]}</em></strong>);
    else if (m[3]) out.push(<strong key={k}>{m[3]}</strong>);
    else if (m[4]) out.push(<em key={k}>{m[4]}</em>);
    else if (m[5]) out.push(<code key={k} className="rounded-[4px] bg-sel px-1 font-mono text-[0.9em]">{m[5]}</code>);
    else out.push(<br key={k} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.map((n, i) => (typeof n === "string" ? <Fragment key={`${key}-t${i}`}>{n.replace(/\\\|/g, "|")}</Fragment> : n));
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        const lines = b.split("\n");
        const h = /^(#{1,6}) (.*)$/.exec(b.trim());
        if (h && lines.length === 1) {
          const size = ["1.45em", "1.25em", "1.1em", "1em", "1em", "1em"][h[1].length - 1];
          return (
            <div key={i} className="font-semibold tracking-[-0.01em]" style={{ fontSize: size }}>
              {inline(h[2], i)}
            </div>
          );
        }
        if (lines.every((l) => /^\s*[-*] /.test(l))) {
          return (
            <ul key={i} className="space-y-1">
              {lines.map((l, j) => {
                const depth = Math.floor((l.match(/^\s*/)?.[0].length ?? 0) / 2);
                return (
                  <li key={j} className="flex gap-2" style={{ paddingLeft: `${depth * 1.25}em` }}>
                    <span className="text-faint">•</span>
                    <span>{inline(l.replace(/^\s*[-*] /, ""), i * 100 + j)}</span>
                  </li>
                );
              })}
            </ul>
          );
        }
        if (lines.length >= 2 && lines.every((l) => l.trim().startsWith("|")) && /^\|?\s*-{3}/.test(lines[1].trim().replace(/^\|\s*/, "|"))) {
          const head = cells(lines[0]);
          const body = lines.slice(2).map(cells);
          return (
            <div key={i} className="overflow-x-auto">
              <table className="text-[0.9em]">
                <thead>
                  <tr>
                    {head.map((c, j) => (
                      <th key={j} className="border-b border-border px-2 py-1 text-left font-semibold">
                        {inline(c, j)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {body.map((r, k) => (
                    <tr key={k}>
                      {r.map((c, j) => (
                        <td key={j} className="border-b border-border px-2 py-1">
                          {inline(c, k * 100 + j)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(b, i)}
          </p>
        );
      })}
    </div>
  );
}
