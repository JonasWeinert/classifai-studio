import clsx from "clsx";
import { ArrowRight, Check, Cpu, Download, Play, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, Progress } from "../components/ui";
import { api, errorMessage, events } from "../lib/api";
import { useApp } from "../lib/app";
import { bytes } from "../lib/format";

const STARTER = "laya";

export function Onboarding({ onSkip }: { onSkip: () => void }) {
  const { engine, refreshEngine, models, pull, pulls, refreshModels, go } = useApp();
  const [busy, setBusy] = useState<null | "install" | "start">(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const un = events.installLog((l) => setLog((x) => [...x.slice(-200), l]));
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const installed = !!engine?.installed;
  const running = !!engine?.running;
  const hasModel = models.length > 0;
  const step = !installed ? 0 : !running ? 1 : !hasModel ? 2 : 3;
  const p = pulls[STARTER];

  const run = async (kind: "install" | "start") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "install") await api.engineInstall();
      else await api.engineStart();
      await refreshEngine();
      await refreshModels();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const steps = [
    { title: "Install the Ollaya engine", body: "Ollaya runs open decision models locally. ClassifAI installs its own copy into the app folder — no admin rights, no system service.", icon: <Download className="size-4" /> },
    { title: "Start the engine", body: "The engine runs in the background on 127.0.0.1:11435 while ClassifAI is open.", icon: <Play className="size-4" /> },
    { title: "Download a starter model", body: "Laya picks an English or multilingual model automatically and is fast on any CPU (~1.5 GB).", icon: <Cpu className="size-4" /> },
  ];

  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="titlebar absolute inset-x-0 top-0 h-12" data-tauri-drag-region />
      <div className="relative m-auto w-full max-w-[560px] px-6 fade-up">
        <img src="/logo.svg" className="size-14 rounded-[14px] shadow-[0_4px_14px_rgba(0,0,0,.15)]" alt="" />
        <h1 className="mt-5 text-[26px] font-bold tracking-[-0.025em]">Welcome to ClassifAI</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
          Classify text with local decision models, measure them against your ground truth and pick the best one. Everything runs on this machine.
        </p>

        <div className="mt-7 overflow-hidden rounded-[10px] border border-border bg-background">
          {steps.map((s, i) => {
            const done = step > i;
            const active = step === i;
            return (
              <div key={i} className={clsx("border-b border-border p-4 transition-opacity duration-300 last:border-0", !done && !active && "opacity-45")}>
                <div className="flex items-start gap-3">
                  <div className={clsx("grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-300", done ? "bg-good text-white" : active ? "bg-primary text-primary-foreground" : "bg-sel text-faint")}>
                    {done ? <Check className="size-4" strokeWidth={2.5} /> : s.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{s.title}</div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{s.body}</div>

                    {active && i === 0 && (
                      <div className="mt-3 space-y-3">
                        <Button variant="primary" loading={busy === "install"} onClick={() => run("install")} icon={<Download className="size-3.5" />}>
                          Install Ollaya
                        </Button>
                        {log.length > 0 && (
                          <div ref={logRef} className="max-h-36 overflow-auto rounded-[6px] bg-card p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground" data-selectable>
                            {log.map((l, k) => (
                              <div key={k}>{l}</div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {active && i === 1 && (
                      <Button className="mt-3" variant="primary" loading={busy === "start"} onClick={() => run("start")} icon={<Play className="size-3.5" />}>
                        Start engine
                      </Button>
                    )}
                    {active && i === 2 && (
                      <div className="mt-3">
                        {p ? (
                          <div className="space-y-1.5">
                            <Progress value={p.total ? p.completed / p.total : 0} indeterminate={!p.total} />
                            <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                              <span>{p.status}</span>
                              <span>{p.total ? `${bytes(p.completed)} / ${bytes(p.total)}` : ""}</span>
                            </div>
                          </div>
                        ) : (
                          <Button variant="primary" onClick={() => pull(STARTER)} icon={<Download className="size-3.5" />}>
                            Download laya
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
            <ShieldCheck className="size-3.5" />
            Data never leaves your machine. Weights come from their authors on Hugging Face.
          </div>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => go({ page: "models" })}>
            Use cloud models instead
          </Button>
          <Button variant="ghost" size="sm" onClick={onSkip}>
            {step === 3 ? "Continue" : "Skip for now"} <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
