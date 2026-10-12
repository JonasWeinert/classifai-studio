// Fine-tune: train a local decision model on an evaluation's labels. The list shows every
// fine-tune with its progress or result; the trainer (Python, Unsloth, llama.cpp) is set up here
// once.
import { ArrowRight, BookOpen, FlaskConical, FolderOpen, Play, Plus, Sparkles, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { duration, FineTuneBadge, isActive, overallProgress, stageText, TrainerInstalled, TrainerSetup, trainingEta } from "../components/FineTunePieces";
import { Button, Empty, ErrorNote, Modal, PageHeader, Progress, Spinner, Tooltip } from "../components/ui";
import { api, errorMessage, events } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { ago, pct } from "../lib/format";
import { openFineTuneInPlayground } from "../lib/setupPlayground";
import type { FineTune as Job, TrainerStatus } from "../lib/types";

/** Fine-tunes, kept fresh from `finetune://progress`. */
export function useFineTunes() {
  const list = useAsync(() => api.fineTunes(), []);
  const [live, setLive] = useState<Record<string, Job>>({});
  useEffect(() => {
    const un = events.fineTune((f) => {
      setLive((l) => ({ ...l, [f.id]: f }));
      if (!list.data?.some((x) => x.id === f.id)) list.reload();
    });
    return () => void un.then((f) => f());
  }, [list]);
  const jobs = (list.data ?? []).map((f) => live[f.id] ?? f);
  return { ...list, jobs };
}

export function FineTune() {
  const { go, toast } = useApp();
  const tryInPlayground = useTryInPlayground();
  const trainer = useAsync(() => api.trainerStatus(), []);
  const [status, setStatus] = useState<TrainerStatus | null>(null);
  const t = status ?? trainer.data;
  const { jobs, loading, error, reload } = useFineTunes();
  const [deleting, setDeleting] = useState<Job | null>(null);
  const [removing, setRemoving] = useState(false);
  const ready = !!t?.installed && !t.outdated;
  const anyActive = jobs.some((j) => isActive(j.status));

  return (
    <>
      <PageHeader
        title="Fine-tune"
        subtitle="Teach a local decision model your labels. It trains on this Mac and then shows up next to your other models."
        actions={
          <>
            <Button variant="ghost" icon={<BookOpen className="size-3.5" />} onClick={() => go({ page: "docs", topic: "finetuning" })}>
              How it works
            </Button>
            <Button variant="primary" icon={<Plus className="size-3.5" />} disabled={!ready} onClick={() => go({ page: "finetune-new" })}>
              New fine-tune
            </Button>
          </>
        }
      />
      {error && <ErrorNote>{error}</ErrorNote>}
      {t && !ready && (
        <div className="mb-7">
          <TrainerSetup status={t} onChange={setStatus} />
        </div>
      )}
      {loading && jobs.length === 0 && <Spinner />}
      {!loading && jobs.length === 0 && <HowItWorks ready={ready} />}

      {jobs.length > 0 && (
        <table className="w-full text-[13px]">
          <thead className="border-b border-border text-[11.5px] text-faint">
            <tr>
              <th className="py-2.5 text-left font-medium">Model</th>
              <th className="px-3 py-2.5 text-left font-medium">Base</th>
              <th className="px-3 py-2.5 text-left font-medium">Data</th>
              <th className="px-3 py-2.5 text-left font-medium">Status</th>
              <th className="px-3 py-2.5 text-right font-medium">
                <Tooltip content="Accuracy on the calibration rows, before and after training. The held-out test is on the fine-tune's page.">
                  <span className="cursor-help underline decoration-dotted underline-offset-2">Accuracy</span>
                </Tooltip>
              </th>
              <th className="py-2.5 text-right font-medium">Created</th>
              <th className="w-[1%]" />
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const eta = trainingEta(j);
              return (
                <tr key={j.id} onClick={() => go({ page: "finetune-run", id: j.id })} className="group cursor-pointer border-t border-border hover:bg-sel/50">
                  <td className="py-2.5">
                    <div className="max-w-[18rem] truncate font-medium">{j.name}</div>
                    <div className="font-mono text-[11px] text-faint">{j.model}</div>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{j.base_title}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    <span className="block max-w-[14rem] truncate">{j.dataset_name}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    {isActive(j.status) ? (
                      <div className="w-44">
                        <Progress value={overallProgress(j)} indeterminate={j.status === "queued"} />
                        <div className="mt-1 truncate text-[11px] text-muted-foreground">
                          {stageText(j)}
                          {eta != null && ` · ${duration(eta)} left`}
                        </div>
                      </div>
                    ) : (
                      <FineTuneBadge status={j.status} />
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-[12px] tnum">
                    {j.before && j.after ? (
                      <span>
                        <span className="text-muted-foreground">{pct(j.before.accuracy, 0)}</span>
                        <ArrowRight className="mx-1 inline size-3 text-faint" />
                        <span className={j.after.accuracy > j.before.accuracy ? "text-good" : ""}>{pct(j.after.accuracy, 0)}</span>
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2.5 text-right text-[12px] text-faint">{ago(j.created_at)}</td>
                  <td className="py-1.5 pl-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      {j.status === "ready" && (
                        <Tooltip content="Try in the Playground">
                          <Button size="icon" variant="ghost" icon={<Play className="size-3.5" />} onClick={() => tryInPlayground(j)} />
                        </Tooltip>
                      )}
                      {isActive(j.status) ? (
                        <Tooltip content="Stop">
                          <Button size="icon" variant="ghost" icon={<Square className="size-3" />} onClick={() => api.fineTuneCancel(j.id)} />
                        </Tooltip>
                      ) : (
                        <Tooltip content="Delete">
                          <Button size="icon" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(j)} />
                        </Tooltip>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {t?.installed && (
        <div className="mt-10 flex items-center gap-3 border-t border-border pt-4">
          <TrainerInstalled status={t} />
          <Tooltip content={t.path}>
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3" />} onClick={() => reveal(t.path)}>
              Show
            </Button>
          </Tooltip>
          {t.outdated && <TrainerSetup status={t} onChange={setStatus} compact />}
          <Button size="sm" variant="danger" className="ml-auto" disabled={anyActive} onClick={() => setRemoving(true)}>
            Remove trainer…
          </Button>
        </div>
      )}

      <DeleteFineTune
        job={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          toast(`Deleted ${deleting!.name}`);
          reload();
        }}
      />
      <Modal
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove the trainer?"
        footer={
          <>
            <Button onClick={() => setRemoving(false)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-bad"
              onClick={async () => {
                try {
                  setStatus(await api.trainerUninstall());
                  toast("Removed the trainer");
                } catch (e) {
                  toast(errorMessage(e), "bad");
                }
                setRemoving(false);
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p className="text-muted-foreground">
          Python, Unsloth and llama.cpp are deleted ({t ? Math.round(t.size_bytes / 1e9 * 10) / 10 : 0} GB). Your fine-tuned models stay, but they can't answer until the trainer is set up again. Downloaded base
          models stay in the Hugging Face cache.
        </p>
      </Modal>
    </>
  );
}

/** Open the Playground on a held-out row with the fine-tune's questions, the fine-tune selected
 *  next to the model it started from. */
export function useTryInPlayground() {
  const { go, models, toast } = useApp();
  return async (j: Job) => {
    try {
      await openFineTuneInPlayground(j, models.map((m) => m.name));
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
    go({ page: "quick" });
  };
}

export async function reveal(path: string) {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path.replace(/^~/, ""));
  } catch {
    /* not in the app */
  }
}

function HowItWorks({ ready }: { ready: boolean }) {
  const { go } = useApp();
  const steps = [
    { icon: <FlaskConical />, title: "Set up", text: "Pick a labelled dataset and write your questions, as for an evaluation. Or start from an evaluation you already ran." },
    { icon: <Sparkles />, title: "Train", text: "Some rows are held out; the models you compare against answer them, then the fine-tune trains on the rest." },
    { icon: <Play />, title: "Use it", text: "The model appears under On this Mac in the Playground, Bulk and evaluations, like any other." },
  ];
  return (
    <div className="py-6">
      <Empty icon={<Sparkles />} title="No fine-tunes yet" action={ready ? <Button variant="primary" onClick={() => go({ page: "finetune-new" })}>New fine-tune</Button> : undefined}>
        A fine-tuned model learns your labels, wording and edge cases. On a few hundred to a few thousand labelled rows it often beats much larger general models.
      </Empty>
      <div className="mx-auto grid max-w-[44rem] grid-cols-3 gap-6">
        {steps.map((s, i) => (
          <div key={s.title} className="text-[12.5px]">
            <div className="mb-2 flex items-center gap-2 font-semibold text-foreground [&_svg]:size-4 [&_svg]:text-primary">
              {s.icon}
              {i + 1}. {s.title}
            </div>
            <p className="leading-relaxed text-muted-foreground">{s.text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DeleteFineTune({ job, onClose, onDeleted }: { job: Job | null; onClose: () => void; onDeleted: () => void }) {
  const { toast, refreshModels } = useApp();
  return (
    <Modal
      open={!!job}
      onClose={onClose}
      title="Delete fine-tune?"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            className="!bg-bad"
            onClick={async () => {
              try {
                await api.fineTuneDelete(job!.id);
                refreshModels();
                onDeleted();
              } catch (e) {
                toast(errorMessage(e), "bad");
              }
              onClose();
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">
        The model <span className="font-mono text-[12px] text-foreground">{job?.model}</span> and its training files are removed. Evaluations that used it, and the held-out test dataset, stay.
      </p>
    </Modal>
  );
}
