// Question sets: saved, versioned questions with their context. Create and edit them here; load
// them in the Playground and Bulk, or start an evaluation from one.
import { Panes } from "../components/Panes";
import { FileUp, FlaskConical, Layers, Plus, Rows3, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ImportQuestionsModal } from "../components/ImportQuestions";
import { QuestionEditor } from "../components/QuestionsSection";
import { Button, compareValues, Empty, ErrorNote, Input, Modal, PageHeader, SearchField, Section, Select, SortTh, Spinner, Textarea, Tooltip, type SortState } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago } from "../lib/format";
import { blank, EXAMPLE, isComplete, KINDS, loadSetIntoDraft, newKey, type QDraft } from "../lib/questionDraft";
import { slugId } from "../lib/questions";
import type { QuestionSet, QuestionSetSummary } from "../lib/types";

type Key = "name" | "questions" | "version" | "updated";

export function QuestionSets() {
  const { go, toast } = useApp();
  const sets = useAsync(() => api.questionSets(), []);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState<Key>>({ key: "updated", desc: true });
  const [deleting, setDeleting] = useState<QuestionSetSummary | null>(null);
  const [importing, setImporting] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (sets.data ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
    const v = (s: QuestionSetSummary, k: Key) => (k === "name" ? s.name : k === "questions" ? s.question_count : k === "version" ? s.version : s.updated_at);
    if (sort) out.sort((a, b) => compareValues(v(a, sort.key), v(b, sort.key)) * (sort.desc ? -1 : 1));
    return out;
  }, [sets.data, search, sort]);

  const use = async (id: string, page: "quick" | "bulk-new") => {
    loadSetIntoDraft(await api.questionSet(id));
    go({ page });
  };

  return (
    <>
      <PageHeader
        title="Question sets"
        subtitle="Saved questions with their options and context. Load them in the Playground and Bulk, or evaluate models with them."
        actions={
          <>
            <Button icon={<FileUp className="size-3.5" />} onClick={() => setImporting(true)}>
              Import…
            </Button>
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => go({ page: "question-set" })}>
              New question set
            </Button>
          </>
        }
      />
      {sets.error && <ErrorNote>{sets.error}</ErrorNote>}
      {sets.loading && !sets.data && <Spinner />}
      {sets.data?.length === 0 && (
        <Empty icon={<Layers />} title="No question sets yet" action={
            <div className="flex gap-2">
              <Button icon={<FileUp className="size-3.5" />} onClick={() => setImporting(true)}>
                Import from a file
              </Button>
              <Button variant="primary" onClick={() => go({ page: "question-set" })}>
                New question set
              </Button>
            </div>
          }
        >
          Create one here, or save the questions you're working on in the Playground or Bulk.
        </Empty>
      )}
      {!!sets.data?.length && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <SearchField value={search} onChange={setSearch} placeholder="Search sets" />
            <span className="ml-auto text-[12px] text-faint tnum">{search ? `${rows.length} of ${sets.data.length}` : `${sets.data.length} sets`}</span>
          </div>
          <table className="w-full text-[13px]">
            <thead className="border-b border-border text-[11.5px] text-faint">
              <tr>
                <SortTh k="name" sort={sort} onSort={setSort}>Name</SortTh>
                <SortTh k="questions" sort={sort} onSort={setSort} align="right" className="px-3">Questions</SortTh>
                <SortTh k="version" sort={sort} onSort={setSort} align="right" className="px-3">Version</SortTh>
                <SortTh k="updated" sort={sort} onSort={setSort} align="right" className="px-3">Updated</SortTh>
                <th className="w-[1%]" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} onClick={() => go({ page: "question-set", id: s.id })} className="group cursor-pointer border-t border-border hover:bg-sel/50">
                  <td className="py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Layers className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 max-w-[36rem]">
                        <div className="truncate font-medium">{s.name}</div>
                        {s.description && <div className="truncate text-[12px] text-muted-foreground">{s.description}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-muted-foreground tnum">{s.question_count}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] text-muted-foreground">v{s.version}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right text-[12px] text-faint">{ago(s.updated_at)}</td>
                  <td className="py-1.5 pl-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <Tooltip content="Use in the Playground">
                        <Button size="icon" variant="ghost" icon={<Zap className="size-3.5" />} onClick={() => use(s.id, "quick")} />
                      </Tooltip>
                      <Tooltip content="New Bulk run with this set">
                        <Button size="icon" variant="ghost" icon={<Rows3 className="size-3.5" />} onClick={() => use(s.id, "bulk-new")} />
                      </Tooltip>
                      <Tooltip content="New evaluation with this set">
                        <Button size="icon" variant="ghost" icon={<FlaskConical className="size-3.5" />} onClick={() => go({ page: "new-experiment", fromSet: s.id })} />
                      </Tooltip>
                      <Tooltip content="Delete">
                        <Button size="icon" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(s)} />
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="py-10 text-center text-[12.5px] text-muted-foreground">No sets match “{search}”.</div>}
        </>
      )}
      <ImportQuestionsModal open={importing} onClose={() => setImporting(false)} />
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.name}”?`}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-bad"
              onClick={async () => {
                try {
                  await api.questionSetDelete(deleting!.id);
                  toast(`Deleted ${deleting!.name}`);
                  sets.reload();
                } catch (e) {
                  toast(errorMessage(e), "bad");
                }
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground">All {deleting?.version} versions are removed. Evaluations that used it keep their questions.</p>
      </Modal>
    </>
  );
}

/** Create a set (no id) or edit one: every save of changed questions is a new version. */
export function QuestionSetEditor({ id }: { id?: string }) {
  const { go, toast } = useApp();
  const [loaded, setLoaded] = useState<QuestionSet | null>(null);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [context, setContext] = useState("");
  const [qs, setQs] = useState<QDraft[]>(() => (id ? [] : [blank()]));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    api
      .questionSet(id, version)
      .then((q) => {
        setLoaded(q);
        setName(q.name);
        setDescription(q.description);
        setContext(q.payload.context ?? "");
        setQs(q.payload.questions.map((x) => ({ ...x, key: newKey() })));
      })
      .catch(setError);
  }, [id, version]);

  const built = useMemo(() => {
    const ids: string[] = [];
    return qs.map((q) => {
      const qid = slugId(q.text || q.kind, ids);
      ids.push(qid);
      return { id: qid, q: isComplete(q, context) };
    });
  }, [qs, context]);
  const invalid = built.filter((b) => !b.q).length;
  const latest = loaded ? (version ?? loaded.version) : 0;

  const save = async () => {
    setBusy(true);
    try {
      const s = await api.questionSetSave({ id: id ?? null, name: name.trim(), description: description.trim(), payload: { context, questions: qs.map(({ key: _k, column: _c, expected: _e, ...q }) => q) } });
      toast(`Saved “${s.name}” · v${s.version}`, "good");
      if (!id) go({ page: "question-set", id: s.id });
      else {
        setVersion(undefined);
        setLoaded({ ...(loaded as QuestionSet), version: s.version, name: s.name });
      }
    } catch (e) {
      toast(errorMessage(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorNote error={error} />;
  if (id && !loaded) return <Spinner />;

  return (
    <>
      <PageHeader
        back={{ label: "Question sets", onClick: () => go({ page: "question-sets" }) }}
        title={id ? loaded!.name : "New question set"}
        subtitle={id ? `Version ${latest} · ${qs.length} question${qs.length === 1 ? "" : "s"}` : "Questions, their options and context, saved for reuse."}
        actions={
          <>
            {id && loaded && loaded.version > 1 && (
              <Select
                className="min-w-[8rem]"
                value={String(version ?? "")}
                onChange={(v) => setVersion(v ? Number(v) : undefined)}
                options={[{ value: "", label: "Latest version" }, ...Array.from({ length: loaded.version - 1 }, (_, i) => loaded.version - 1 - i).map((v) => ({ value: String(v), label: `Version ${v}` }))]}
              />
            )}
            {id && (
              <Button icon={<Zap className="size-3.5" />} onClick={async () => (loadSetIntoDraft(await api.questionSet(id, version)), go({ page: "quick" }))}>
                Use in Playground
              </Button>
            )}
            <Button variant="primary" loading={busy} disabled={!name.trim() || invalid > 0 || qs.length === 0} onClick={save}>
              {id ? (version ? `Restore as v${loaded!.version + 1}` : "Save new version") : "Create set"}
            </Button>
          </>
        }
      />
      <Panes template="minmax(0,1fr) 280px" className="gap-10">
        <div className="min-w-0">
          <Section title="Details">
            <div className="space-y-2">
              <Input value={name} onChange={setName} placeholder="Name, e.g. Ticket triage" autoFocus={!id} />
              <Input value={description} onChange={setDescription} placeholder="Description (optional)" />
              <Textarea rows={2} value={context} onChange={(e) => setContext(e.target.value)} placeholder="Shared context every question should know (optional)" />
            </div>
          </Section>
          <Section
            title="Questions"
            subtitle={invalid ? `${invalid} incomplete` : "All questions are answered in a single pass per model."}
            actions={
              qs.length === 0 || (qs.length === 1 && !qs[0].text) ? (
                <Button size="sm" variant="ghost" onClick={() => setQs(EXAMPLE())}>
                  Start from an example
                </Button>
              ) : undefined
            }
          >
            <div className="divide-y divide-border">
              {qs.map((q, i) => (
                <QuestionEditor
                  key={q.key}
                  q={q}
                  index={i}
                  id={built[i]?.id}
                  invalid={!built[i]?.q}
                  routing={{ qs, setQs }}
                  onChange={(p) => setQs(qs.map((x) => (x.key === q.key ? { ...x, ...p } : x)))}
                  onRemove={qs.length > 1 ? () => setQs(qs.filter((x) => x.key !== q.key)) : undefined}
                />
              ))}
              <div className="pt-3">
                <Button variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setQs([...qs, blank()])}>
                  Add question
                </Button>
              </div>
            </div>
          </Section>
        </div>
        <aside>
          <Section title="Overview">
            <ol className="space-y-2 text-[12.5px]">
              {qs.map((q, i) => (
                <li key={q.key} className="flex gap-2">
                  <span className="w-4 shrink-0 text-faint tnum">{i + 1}</span>
                  <span className="min-w-0">
                    <span className="block truncate">{q.text || <span className="text-faint">Untitled</span>}</span>
                    <span className="text-[11.5px] text-muted-foreground">{KINDS.find((k) => k.value === q.kind)!.label}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </aside>
      </Panes>
    </>
  );
}
