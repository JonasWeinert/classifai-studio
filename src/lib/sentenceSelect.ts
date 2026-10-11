// Keyboard sentence selection in manual labelling: the entry's fields (elements with
// `data-column`) split into sentences, and a real text selection set over one or more of them,
// so the usual "add as context" flow (button or ↵) works on it.
import { split } from "./explain";

export interface SentenceSpan {
  field: HTMLElement;
  start: number;
  end: number;
}

/** Every sentence of every field under `root`, in reading order. Offsets are into the field's text. */
export function entrySentences(root: HTMLElement): SentenceSpan[] {
  return [...root.querySelectorAll<HTMLElement>("[data-column]")].flatMap((field) => split(field.textContent ?? "", "sentence").map((p) => ({ field, start: p.start, end: p.end })));
}

/** The text node and offset at character `offset` of `field`'s text. */
function pointAt(field: HTMLElement, offset: number): [Node, number] {
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  let left = offset;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (left <= len) return [n, left];
    left -= len;
    last = n;
  }
  return last ? [last, last.data.length] : [field, 0];
}

/**
 * Select sentences `a`..`b` (either order). A selection stays inside one field (context passages
 * belong to a column), so it stops at the edge of `a`'s field.
 */
export function selectSentences(list: SentenceSpan[], a: number, b: number) {
  const [from, to] = a <= b ? [a, b] : [b, a];
  const anchorField = list[a].field;
  let lo = from, hi = to;
  while (list[lo].field !== anchorField) lo++;
  while (list[hi].field !== anchorField) hi--;
  const range = document.createRange();
  range.setStart(...pointAt(list[lo].field, list[lo].start));
  range.setEnd(...pointAt(list[hi].field, list[hi].end));
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  (range.startContainer.parentElement ?? list[lo].field).scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** The current selection as a context passage, when it lies inside one field under `root`. */
export function selectedPassage(root: HTMLElement | null): { column: string; text: string } | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const node = range.commonAncestorContainer;
  const field = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-column]");
  const text = sel.toString().replace(/\s+/g, " ").trim();
  return field && text ? { column: field.dataset.column!, text } : null;
}
