import { Database, FileUp, Link2, FlaskConical, LayoutGrid, List, Sparkles, Table2 } from "lucide-react";
import { useEffect, useState } from "react";
import { HfImportModal } from "../components/HfImport";
import { FILE_FILTERS, FilesImportModal, ImportChooser, WorkbookImportModal, type ImportKind } from "../components/ImportDialogs";
import { extOf, pickFiles, SPREADSHEET_EXTENSIONS, WORKBOOK_EXTENSIONS } from "../lib/api";
import { Button, Card, Empty, ErrorNote, Input, Modal, PageHeader, Segmented, Spinner, Tooltip } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago } from "../lib/format";
import { load, save } from "../lib/persist";
import { SAMPLE_DATASET } from "../lib/sample";
import { useImportDataset } from "../lib/useImportDataset";
import type { Dataset } from "../lib/types";

type View = "list" | "tiles";
const VIEW_KEY = "datasets.view";

const readView = (): View => (load<View>(VIEW_KEY, "list") === "tiles" ? "tiles" : "list");

/** Rough shape of a pasted table: rows × columns, or null when it doesn't look like one. */
function tableShape(text: string): { rows: number; cols: number } | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(",") ? "," : null;
  if (!sep) return null;
  return { rows: lines.length - 1, cols: lines[0].split(sep).length };
}

export function Datasets({ hf: openHf, chooser: openChooser, workbook: openWorkbook, files: openFiles }: { hf?: boolean; chooser?: boolean; workbook?: string; files?: string[] } = {}) {
  const { go } = useApp();
  const { data, error, loading, reload } = useAsync(() => api.datasets(), []);
  const [hf, setHf] = useState(!!openHf);
  const [chooser, setChooser] = useState(!!openChooser);
  const [workbook, setWorkbook] = useState<string | null>(openWorkbook ?? null);
  const [files, setFiles] = useState<string[]>(openFiles ?? []);
  useEffect(() => {
    if (openChooser) setChooser(true);
    if (openWorkbook) setWorkbook(openWorkbook);
    if (openFiles?.length) setFiles(openFiles);
  }, [openChooser, openWorkbook, openFiles]);
  const pick = async (k: ImportKind) => {
    setChooser(false);
    if (k === "hf") return setHf(true);
    if (k === "files") return setFiles(await pickFiles(FILE_FILTERS));
    const [path] = await pickFiles([{ name: "Spreadsheets", extensions: SPREADSHEET_EXTENSIONS }], false);
    if (!path) return;
    if (WORKBOOK_EXTENSIONS.includes(extOf(path))) setWorkbook(path);
    else imp.importPath(path);
  };
  useEffect(() => {
    if (openHf) setHf(true);
  }, [openHf]);
  const exps = useAsync(() => api.experiments(), []);
  const imp = useImportDataset();
  const [view, setViewState] = useState<View>(readView);
  const [pasted, setPasted] = useState<{ text: string; name: string; rows: number; cols: number } | null>(null);

  const setView = (v: View) => {
    setViewState(v);
    save(VIEW_KEY, v);
  };

  // D1: paste a table copied from Excel / Numbers (TSV) or CSV text anywhere on this page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable=true]") || t.isContentEditable)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const shape = tableShape(text);
      if (!shape) return;
      e.preventDefault();
      setPasted({ text, name: "Pasted table", ...shape });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const count = (d: Dataset) => exps.data?.filter((e) => e.dataset_id === d.id).length ?? 0;

  return (
    <>
      <PageHeader
        title="Datasets"
        subtitle="Import CSV, TSV, JSON or JSONL — or drop a file anywhere, or paste a table."
        actions={
          <>
            {data && data.length > 0 && (
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: "list", label: <List className="size-3.5" aria-label="List" /> },
                  { value: "tiles", label: <LayoutGrid className="size-3.5" aria-label="Tiles" /> },
                ]}
              />
            )}
            <Button variant="primary" icon={<FileUp className="size-3.5" />} loading={imp.busy} onClick={() => setChooser(true)}>
              Import
            </Button>
          </>
        }
      />
      <ImportChooser open={chooser} onClose={() => setChooser(false)} onPick={pick} />
      <HfImportModal open={hf} onClose={() => setHf(false)} onImported={() => reload()} />
      <WorkbookImportModal path={workbook} onClose={() => setWorkbook(null)} />
      <FilesImportModal paths={files} onChange={setFiles} onClose={() => setFiles([])} />
      {error && <ErrorNote error={error} />}
      {loading && !data && <Spinner />}
      {data && data.length === 0 && (
        <div>
          <Empty
            icon={<Database className="size-5" />}
            title="No datasets yet"
            action={
              <div className="flex gap-2">
                <Button icon={<Sparkles className="size-3.5" />} disabled={imp.busy} onClick={() => imp.importText(SAMPLE_DATASET.name, SAMPLE_DATASET.text)}>
                  Try with sample data
                </Button>
                <Button variant="primary" icon={<FileUp className="size-3.5" />} loading={imp.busy} onClick={() => setChooser(true)}>
                  Import your first dataset
                </Button>
              </div>
            }
          >
            Each row needs some text to classify and, for evaluation, a column with the correct label. You can also drop a file anywhere or paste a table copied from Excel or Numbers.
          </Empty>
        </div>
      )}

      {data && data.length > 0 && view === "list" && (
        <table className="w-full text-[13px] fade-up">
          <thead className="border-b border-border text-[11.5px] text-faint">
            <tr>
              <th className="py-2.5 text-left font-medium">Name</th>
              <th className="px-3 py-2.5 text-right font-medium">Rows</th>
              <th className="px-3 py-2.5 text-left font-medium">Columns</th>
              <th className="px-3 py-2.5 text-right font-medium">Evaluations</th>
              <th className="px-3 py-2.5 text-right font-medium">Imported</th>
              <th className="w-[1%] py-2.5" />
            </tr>
          </thead>
          <tbody>
            {data.map((d) => {
              const n = count(d);
              return (
                <tr key={d.id} onClick={() => go({ page: "dataset", id: d.id })} className="group cursor-pointer border-t border-border hover:bg-sel/50">
                  <td className="py-2.5">
                    <div className="flex max-w-[18rem] items-center gap-2.5">
                      <Table2 className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate font-medium">{d.name}</span>
                      {d.parent_id && (
                        <Tooltip content={`Rows linked to ${d.parent_name}; stores only ${d.added_columns?.length ?? 0} added columns`}>
                          <span className="inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-full bg-sel px-2 py-px text-[11px] text-muted-foreground">
                            <Link2 className="size-3 shrink-0" /> <span className="truncate">{d.parent_name}</span>
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] text-muted-foreground tnum">{d.row_count.toLocaleString()}</td>
                  {/* Takes the space that's left and truncates within it (max-w-0 lets the column shrink). */}
                  <td className="w-full max-w-0 px-3 py-2.5">
                    <Tooltip content={d.columns.join(", ")} wrapperClassName="block">
                      <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
                        <span className="text-foreground tnum">{d.columns.length}</span> · {d.columns.join(", ")}
                      </span>
                    </Tooltip>
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground tnum">{n || <span className="text-faint">—</span>}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right text-[12px] text-faint">{ago(d.created_at)}</td>
                  <td className="py-1.5 pl-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="whitespace-nowrap opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        go({ page: "new-experiment", datasetId: d.id });
                      }}
                    >
                      New evaluation →
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {data && data.length > 0 && view === "tiles" && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
          {data.map((d) => {
            const n = count(d);
            return (
              <Card key={d.id} className="group cursor-pointer p-4 transition-colors duration-150 hover:bg-sel fade-up" onClick={() => go({ page: "dataset", id: d.id })}>
                <div className="flex items-start gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-background text-muted-foreground">
                    <Table2 className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{d.name}</div>
                    <div className="mt-0.5 text-[12px] text-muted-foreground tnum">
                      {d.row_count.toLocaleString()} rows · {d.columns.length} columns · {ago(d.created_at)}
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {d.columns.slice(0, 6).map((c) => (
                    <span key={c} className="rounded-full bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                      {c}
                    </span>
                  ))}
                  {d.columns.length > 6 && <span className="px-1 text-[11px] text-faint">+{d.columns.length - 6}</span>}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <FlaskConical className="size-3.5" /> {n} evaluation{n === 1 ? "" : "s"}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      go({ page: "new-experiment", datasetId: d.id });
                    }}
                  >
                    New evaluation →
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={!!pasted}
        onClose={() => setPasted(null)}
        title="Import pasted table?"
        footer={
          <>
            <Button onClick={() => setPasted(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={imp.busy}
              onClick={async () => {
                if (!pasted) return;
                const p = pasted;
                setPasted(null);
                await imp.importText(p.name.trim() || "Pasted table", p.text);
              }}
            >
              Import
            </Button>
          </>
        }
      >
        {pasted && (
          <div className="space-y-3">
            <p className="text-muted-foreground">
              The clipboard holds a table with <b className="text-foreground tnum">{pasted.rows.toLocaleString()}</b> rows and <b className="text-foreground tnum">{pasted.cols}</b> columns. The first line is used as column names.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Name:</span>
              <Input autoFocus value={pasted.name} onChange={(name) => setPasted({ ...pasted, name })} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
