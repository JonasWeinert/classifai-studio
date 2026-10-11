// Import a question set from JSON, CSV or JSON Schema: choose a file or paste, check what was
// inferred (and change a type if needed), then save it as a new set.
import { cn } from "@/lib/utils";
import { ChevronRight, FileJson, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, pickFiles } from "../lib/api";
import { useApp } from "../lib/app";
import { describeError } from "../lib/errors";
import { isComplete, KINDS, type Kind, type QDraft } from "../lib/questionDraft";
import { parseQuestionFile, type ImportedSet } from "../lib/questionImport";
import type { SetQuestion } from "../lib/types";
import { Clamp } from "./Clamp";
import { Button, Input, Modal, Select, Textarea } from "./ui";

const EXAMPLE = `question,type,options
Which team should handle this?,,billing; technical; account
Is the customer asking for a refund?,,
How frustrated is the customer?,scale,calm; annoyed; frustrated; furious`;

/** What the options of a question look like in one line. */
function summary(q: SetQuestion) {
  if (q.kind === "choice" || q.kind === "multi" || q.kind === "rank") return q.options.map((o) => o.name).join(" · ");
  if (q.kind === "score") return q.levels.join(" → ");
  if (q.kind === "number") return `${q.values}${q.unit ? ` ${q.unit}` : ""}`;
  if (q.kind === "noul") return [q.yes && `yes: ${q.yes}`, q.no && `no: ${q.no}`].filter(Boolean).join(" · ") || "Yes / No";
  return "Open answer";
}

/** Changing a type keeps what carries over: option names become levels and back. */
function retype(q: SetQuestion, kind: Kind): SetQuestion {
  if (kind === q.kind) return q;
  const names = q.options.length ? q.options.map((o) => o.name) : q.levels;
  return {
    ...q,
    kind,
    options: kind === "choice" || kind === "multi" || kind === "rank" ? (q.options.length ? q.options : names.map((name) => ({ name, description: "" }))) : q.options,
    levels: kind === "score" ? (names.length >= 2 ? names : ["Low", "Medium", "High"]) : q.levels,
    values: kind === "number" && !q.values ? (names.every((n) => n.trim() !== "" && Number.isFinite(Number(n))) && names.length ? names.join(", ") : "0, 1, 5, 10, 50, 100") : q.values,
  };
}

export function ImportQuestionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, go } = useApp();
  const [text, setText] = useState("");
  const [file, setFile] = useState("pasted.csv");
  const [name, setName] = useState("");
  const [qs, setQs] = useState<SetQuestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText("");
    setFile("pasted.csv");
    setQs([]);
    setName("");
  }, [open]);

  const parsed = useMemo((): { ok: ImportedSet } | { error: string } | null => {
    if (!text.trim()) return null;
    try {
      return { ok: parseQuestionFile(file, text) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [text, file]);
  const result = parsed && "ok" in parsed ? parsed.ok : null;
  useEffect(() => {
    setQs(result?.payload.questions ?? []);
    if (result?.name) setName(result.name.charAt(0).toUpperCase() + result.name.slice(1));
  }, [result]);

  const choose = async () => {
    const [path] = await pickFiles([{ name: "Question sets", extensions: ["json", "csv", "tsv", "txt"] }], false);
    if (!path) return;
    try {
      setFile(path.split(/[\\/]/).pop() ?? path);
      setText(await api.readTextFile(path));
    } catch (e) {
      toast(describeError(e).message, "bad");
    }
  };

  const incomplete = qs.filter((q) => !isComplete({ ...q, key: 0 } as QDraft, result?.payload.context ?? "")).length;
  const submit = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const s = await api.questionSetSave({ id: null, name: name.trim(), description: result.description ?? `Imported from ${file}`, payload: { context: result.payload.context, questions: qs } });
      toast(`Imported “${s.name}” · ${s.question_count} questions`, "good");
      onClose();
      go({ page: "question-set", id: s.id });
    } catch (e) {
      toast(describeError(e).message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={760}
      title="Import a question set"
      footer={
        <>
          {result && (
            <div className="mr-auto w-64">
              <Input value={name} onChange={setName} placeholder="Set name" />
            </div>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!result || !qs.length || !name.trim()} onClick={submit}>
            Import {qs.length ? `${qs.length} question${qs.length === 1 ? "" : "s"}` : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!result && (
          <>
            <div className="flex items-center gap-3">
              <Button icon={<FileJson className="size-3.5" />} onClick={choose}>
                Choose a file…
              </Button>
              <span className="text-[12px] text-muted-foreground">JSON, JSON Schema or CSV — or paste below</span>
            </div>
            <Textarea
              rows={9}
              value={text}
              onChange={(e) => {
                setFile("pasted.csv");
                setText(e.target.value);
              }}
              placeholder={EXAMPLE}
              className="font-mono text-[12px]"
            />
            {parsed && "error" in parsed && <div className="rounded-[10px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{parsed.error}</div>}
            <div className="grid grid-cols-3 gap-2 text-[11.5px] leading-snug text-muted-foreground">
              <div className="rounded-[10px] bg-card px-3 py-2">
                <b className="font-semibold text-foreground">JSON Schema</b> — each property is a question: enums → pick one, booleans → yes/no, small integer ranges → scale, arrays → pick any or rank, strings → free text.
              </div>
              <div className="rounded-[10px] bg-card px-3 py-2">
                <b className="font-semibold text-foreground">JSON</b> — a list of questions with options, a ClassifAI export, or Ollaya / TypeSafe questions.
              </div>
              <div className="rounded-[10px] bg-card px-3 py-2">
                <b className="font-semibold text-foreground">CSV</b> — a <span className="font-mono">question</span> column, plus optional type, options, description and context; or one row per option.
              </div>
            </div>
          </>
        )}

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{result.format}</span>
              <span className="font-mono">{file}</span>
              <button className="ml-auto text-primary hover:underline" onClick={() => setText("")}>
                Use another file
              </button>
            </div>
            {result.payload.context && (
              <Clamp className="rounded-[10px] border border-dashed border-border-strong px-3 py-2 text-[12px] text-muted-foreground">
                <span className="font-medium text-foreground">Context: </span>
                {result.payload.context}
              </Clamp>
            )}
            <ol className="max-h-[42vh] divide-y divide-border overflow-auto rounded-[12px] bg-card">
              {qs.map((q, i) => (
                <li key={i} className="grid grid-cols-[1.5rem_minmax(0,1fr)_9rem] items-start gap-3 px-3.5 py-2.5">
                  <span className="pt-1 text-[12px] text-faint tnum">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium" title={q.text}>
                      {q.text}
                    </div>
                    <div className="truncate text-[11.5px] text-muted-foreground" title={summary(q)}>
                      {summary(q)}
                    </div>
                  </div>
                  <Select value={q.kind} onChange={(k) => setQs(qs.map((x, j) => (j === i ? retype(x, k as Kind) : x)))} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} />
                </li>
              ))}
            </ol>
            {result.notes.length > 0 && (
              <div>
                <button onClick={() => setShowNotes(!showNotes)} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                  <ChevronRight className={cn("size-3.5 transition-transform", showNotes && "rotate-90")} />
                  <Sparkles className="size-3.5 text-primary" />
                  How the types were decided ({result.notes.length})
                </button>
                {showNotes && (
                  <ul className="mt-1.5 space-y-0.5 pl-6 text-[11.5px] text-muted-foreground">
                    {result.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {incomplete > 0 && <div className="text-[12px] text-warn">{incomplete} question{incomplete === 1 ? " needs" : "s need"} more detail — you can finish {incomplete === 1 ? "it" : "them"} in the editor after importing.</div>}
          </>
        )}
      </div>
    </Modal>
  );
}
