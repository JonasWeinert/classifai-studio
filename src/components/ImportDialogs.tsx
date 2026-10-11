// Importing data: one entry point (ImportChooser) for spreadsheets, Hugging Face and files, the
// workbook dialog (sheet, header row, columns) and the files dialog (documents and images).
import { cn } from "@/lib/utils";
import { File, FileSpreadsheet, FileText, Image as ImageIcon, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, DOCUMENT_EXTENSIONS, extOf, IMAGE_EXTENSIONS, pickFiles } from "../lib/api";
import { useApp } from "../lib/app";
import { describeError } from "../lib/errors";
import type { SheetPreview } from "../lib/types";
import { Button, Input, Modal, Segmented, Select, Spinner } from "./ui";

export type ImportKind = "spreadsheet" | "hf" | "files";

function HfMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2" />
      <circle cx="9" cy="10" r=".7" fill="currentColor" />
      <circle cx="15" cy="10" r=".7" fill="currentColor" />
    </svg>
  );
}

const KINDS: { value: ImportKind; title: string; text: string; formats: string; icon: React.ReactNode }[] = [
  { value: "spreadsheet", title: "Spreadsheet", text: "A table with one row per entry. For Excel files you choose the sheet, header row and columns.", formats: "CSV · TSV · Excel (XLSX, XLS) · ODS · JSON · JSONL", icon: <FileSpreadsheet className="size-6" /> },
  { value: "hf", title: "Hugging Face", text: "A dataset from the Hub by name or link: pick splits and take all rows or a sample.", formats: "Any dataset the Hugging Face viewer can read", icon: <HfMark className="size-6" /> },
  { value: "files", title: "Documents & images", text: "One row per file. Word and PDF become Markdown text; images are copied into ClassifAI's library.", formats: "DOCX · PDF · TXT · Markdown · PNG · JPG · WebP · HEIC", icon: <FileText className="size-6" /> },
];

export function ImportChooser({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (k: ImportKind) => void }) {
  return (
    <Modal open={open} onClose={onClose} width={560} title="Import data">
      <div className="space-y-2">
        {KINDS.map((k) => (
          <button key={k.value} onClick={() => onPick(k.value)} className="group flex w-full items-start gap-4 rounded-[14px] bg-card px-4 py-3.5 text-left transition-colors hover:bg-sel">
            <span className="grid size-11 shrink-0 place-items-center rounded-[11px] bg-background text-primary transition-transform group-hover:scale-105">{k.icon}</span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold">{k.title}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">{k.text}</span>
              <span className="mt-1 block text-[11px] text-faint">{k.formats}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11.5px] text-faint">You can also drop files anywhere in the window, or paste a table copied from Excel or Numbers on this page.</p>
    </Modal>
  );
}

/** Excel / ODS: pick a sheet, click the header row, untick columns you don't want. */
export function WorkbookImportModal({ path, onClose }: { path: string | null; onClose: () => void }) {
  const { toast, go } = useApp();
  const [sheets, setSheets] = useState<SheetPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState("");
  const [header, setHeader] = useState(0);
  const [off, setOff] = useState<number[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const file = path?.split(/[\\/]/).pop() ?? "";

  useEffect(() => {
    if (!path) return;
    setSheets(null);
    setError(null);
    api
      .spreadsheetInspect(path)
      .then((s) => {
        setSheets(s);
        const first = s.find((x) => x.rows > 1) ?? s[0];
        setSheet(first.name);
      })
      .catch((e) => setError(describeError(e).message));
  }, [path]);

  const sh = sheets?.find((s) => s.name === sheet);
  useEffect(() => {
    if (!sh) return;
    // The header is the first row with as many filled cells as the widest of the first rows.
    const filled = sh.preview.map((r) => r.filter((c) => c.trim()).length);
    const most = Math.max(0, ...filled);
    setHeader(Math.max(0, filled.findIndex((n) => n >= Math.max(1, most * 0.8))));
    setOff([]);
    setName(`${file.replace(/\.[^.]+$/, "")}${(sheets?.length ?? 0) > 1 ? ` · ${sh.name}` : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sh?.name]);

  const names = useMemo(() => (sh ? Array.from({ length: sh.width }, (_, c) => sh.preview[header]?.[c]?.trim() || `column_${c + 1}`) : []), [sh, header]);
  const keep = names.map((_, c) => c).filter((c) => !off.includes(c));
  const dataRows = sh ? Math.max(0, sh.rows - header - 1) : 0;

  const submit = async () => {
    if (!path || !sh) return;
    setBusy(true);
    try {
      const d = await api.spreadsheetImport(path, sh.name, header, keep.length === names.length ? [] : keep, name.trim() || undefined);
      toast(`Imported ${d.name} · ${d.row_count.toLocaleString()} rows`, "good");
      onClose();
      go({ page: "dataset", id: d.id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!path}
      onClose={onClose}
      width={880}
      title={`Import ${file}`}
      footer={
        <>
          <div className="mr-auto w-72">
            <Input value={name} onChange={setName} placeholder="Dataset name" />
          </div>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!sh || keep.length === 0} onClick={submit}>
            Import {dataRows ? `~${dataRows.toLocaleString()} rows` : ""} · {keep.length} column{keep.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      {error ? (
        <div className="rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</div>
      ) : !sheets || !sh ? (
        <div className="grid h-40 place-items-center">
          <Spinner delay={0} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {sheets.length > 1 &&
              (sheets.length <= 5 ? (
                <Segmented value={sheet} onChange={setSheet} options={sheets.map((s) => ({ value: s.name, label: s.name }))} />
              ) : (
                <Select className="min-w-[12rem]" value={sheet} onChange={setSheet} options={sheets.map((s) => ({ value: s.name, label: `${s.name} (${s.rows} rows)` }))} />
              ))}
            <span className="text-[12px] text-muted-foreground">
              Header row <b className="font-semibold text-foreground tnum">{header + 1}</b> · click a row number to change it · untick columns to leave them out
            </span>
          </div>
          <div className="max-h-[48vh] overflow-auto rounded-[12px] border border-border" data-selectable>
            <table className="border-collapse text-[12px]">
              <thead className="sticky top-0 z-10 bg-background">
                <tr>
                  <th className="w-10 border-b border-border px-2 py-1.5 text-right font-mono text-[10.5px] font-medium text-faint" />
                  {names.map((n, c) => {
                    const on = !off.includes(c);
                    return (
                      <th key={c} className="border-b border-l border-border px-2 py-1.5 text-left font-medium">
                        <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap">
                          <input type="checkbox" checked={on} onChange={() => setOff(on ? [...off, c] : off.filter((x) => x !== c))} className="accent-[var(--primary)]" />
                          <span className={cn("max-w-[12rem] truncate", on ? "text-foreground" : "text-faint line-through")}>{n}</span>
                        </label>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sh.preview.map((row, r) => (
                  <tr key={r} className={cn(r === header ? "bg-primary/10 font-semibold" : r < header ? "text-faint" : "")}>
                    <td className="border-b border-border px-1 py-0">
                      <button onClick={() => setHeader(r)} title="Use as header row" className={cn("w-full rounded-[4px] px-1 py-1 text-right font-mono text-[10.5px] tnum hover:bg-sel", r === header ? "text-primary" : "text-faint")}>
                        {r + 1}
                      </button>
                    </td>
                    {row.map((v, c) => (
                      <td key={c} className={cn("border-b border-l border-border px-2 py-1", off.includes(c) && "opacity-35")}>
                        <div className={cn("max-w-[16rem] truncate", r < header && "line-through decoration-faint/50")} title={v}>
                          {v}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sh.rows > sh.preview.length && <div className="text-[11.5px] text-faint">Showing the first {sh.preview.length} of {sh.rows.toLocaleString()} rows. Rows above the header are skipped, as are empty rows.</div>}
        </div>
      )}
    </Modal>
  );
}

function kindOf(path: string): { label: string; icon: React.ReactNode } {
  const e = extOf(path);
  if (IMAGE_EXTENSIONS.includes(e)) return { label: "Image", icon: <ImageIcon className="size-4" /> };
  if (e === "pdf") return { label: "PDF → Markdown", icon: <File className="size-4" /> };
  if (e === "docx") return { label: "Word → Markdown", icon: <FileText className="size-4" /> };
  return { label: "Text", icon: <FileText className="size-4" /> };
}

export const FILE_FILTERS = [{ name: "Documents and images", extensions: [...DOCUMENT_EXTENSIONS, ...IMAGE_EXTENSIONS] }];

/** Files to rows: review the list, add or remove files, name the dataset. */
export function FilesImportModal({ paths, onClose, onChange }: { paths: string[]; onClose: () => void; onChange: (p: string[]) => void }) {
  const { toast, go } = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const counts = useMemo(() => {
    const c = { images: 0, docs: 0 };
    paths.forEach((p) => (IMAGE_EXTENSIONS.includes(extOf(p)) ? c.images++ : c.docs++));
    return c;
  }, [paths]);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.filesImport(paths, name.trim() || undefined);
      toast(`Imported ${r.dataset.row_count} file${r.dataset.row_count === 1 ? "" : "s"}${r.skipped.length ? ` · ${r.skipped.length} skipped (${r.skipped[0].reason})` : ""}`, r.skipped.length ? "neutral" : "good");
      onClose();
      go({ page: "dataset", id: r.dataset.id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={paths.length > 0}
      onClose={onClose}
      width={600}
      title="Import documents and images"
      footer={
        <>
          <Button className="mr-auto" variant="ghost" icon={<Plus className="size-3.5" />} onClick={async () => onChange([...new Set([...paths, ...(await pickFiles(FILE_FILTERS))])])}>
            Add files
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!paths.length} onClick={submit}>
            Import {paths.length} file{paths.length === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input value={name} onChange={setName} placeholder={`Dataset name (default: Files (${paths.length}))`} autoFocus />
        <ul className="max-h-[40vh] divide-y divide-border overflow-auto rounded-[12px] bg-card">
          {paths.map((p) => {
            const k = kindOf(p);
            return (
              <li key={p} className="flex items-center gap-3 px-3 py-2">
                <span className="text-muted-foreground">{k.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{p.split(/[\\/]/).pop()}</span>
                  <span className="block truncate font-mono text-[10.5px] text-faint" title={p}>
                    {p}
                  </span>
                </span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{k.label}</span>
                <button onClick={() => onChange(paths.filter((x) => x !== p))} className="grid size-6 place-items-center rounded-full text-faint hover:bg-sel hover:text-foreground" aria-label="Remove">
                  <X className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
        <div className="rounded-[10px] bg-sel px-3 py-2 text-[12px] leading-snug text-muted-foreground">
          One row per file with <span className="font-mono">name</span>, <span className="font-mono">kind</span>, <span className="font-mono">content</span>, <span className="font-mono">file</span> and <span className="font-mono">source_path</span>.
          {counts.docs > 0 && " Word and PDF files are converted to Markdown (text only; scanned PDFs have none)."}
          {counts.images > 0 && " Images are copied into ClassifAI's media folder under a new name and linked from the row; the original stays where it is."}
        </div>
      </div>
    </Modal>
  );
}
