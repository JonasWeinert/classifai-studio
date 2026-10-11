import clsx from "clsx";
import { ArrowRight, Check, Cloud, Cpu, Download, Play, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorNote, Progress, Segmented } from "../components/ui";
import { CliInstall } from "../components/CliInstall";
import { api, errorMessage, events } from "../lib/api";
import { useApp } from "../lib/app";
import { bytes } from "../lib/format";

const STARTER = "laya";
const SMALL = "decima:small";

/**
 * First launch: install and start the engine, download a starter model. `preview` (Settings →
 * Show welcome screen) shows it again with a step switcher; its buttons then do nothing.
 */
export function Onboarding({ onSkip, preview: previewProp }: { onSkip: () => void; preview?: boolean }) {
  // Development builds only, so release builds drop the preview code entirely.
  const preview = import.meta.env.DEV && !!previewProp;
  const { engine, refreshEngine, models, pull: realPull, pulls, refreshModels, go } = useApp();
  const [previewStep, setPreviewStep] = useState(0);
  const pull = (name: string) => (preview ? undefined : realPull(name));
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
  const step = preview ? previewStep : !installed ? 0 : !running ? 1 : !hasModel ? 2 : 3;
  const pulling = pulls[STARTER] ?? pulls[SMALL];
  // ETA from the observed download rate (bytes since the first progress event).
  const startRef = useRef<{ t: number; b: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  useEffect(() => {
    if (!pulling?.total) {
      startRef.current = null;
      setEta(null);
      return;
    }
    const now = performance.now();
    if (!startRef.current) startRef.current = { t: now, b: pulling.completed };
    const secs = (now - startRef.current.t) / 1000;
    const rate = (pulling.completed - startRef.current.b) / Math.max(secs, 0.001);
    setEta(secs > 2 && rate > 0 ? (pulling.total - pulling.completed) / rate : null);
  }, [pulling?.completed, pulling?.total]);

  const run = async (kind: "install" | "start") => {
    if (preview) return;
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
    { title: "Install the engine", body: "Local models run on Ollaya. ClassifAI Studio installs it in its own folder, so you don't need admin rights." },
    { title: "Start the engine", body: "It runs while ClassifAI Studio is open and stops when you quit." },
    { title: "Download a model", body: "Laya handles English and other languages and runs well on any Mac. You can add other models later under Models." },
  ];

  return (
    <div className="relative flex h-full flex-col overflow-y-auto bg-background">
      <div className="titlebar absolute inset-x-0 top-0 h-12" />
      {preview && (
        <div className="absolute top-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-popover py-1 pr-1 pl-3 text-[11.5px] text-muted-foreground shadow-[0_4px_16px_rgba(0,0,0,.08)]">
          Preview. The buttons are disabled.
          <Segmented
            value={String(previewStep)}
            onChange={(v) => setPreviewStep(Number(v))}
            options={[
              { value: "0", label: "Install" },
              { value: "1", label: "Start" },
              { value: "2", label: "Model" },
              { value: "3", label: "Done" },
            ]}
          />
          <button onClick={onSkip} className="rounded-full px-2 py-0.5 font-medium text-foreground hover:bg-sel">
            Close
          </button>
        </div>
      )}
      <div className="relative m-auto w-full max-w-[580px] px-6 py-16 fade-up">
        <img src="/logo.svg" className="size-16 drop-shadow-[0_6px_18px_rgba(0,0,0,.18)]" alt="" />
        <h1 className="mt-5 text-[26px] font-bold tracking-[-0.025em]">Welcome to ClassifAI Studio</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
          ClassifAI Studio lets models answer questions about your text. It works with two kinds of models, and you can run both on the same questions and check them against your own labels.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <div className="rounded-[14px] bg-card p-3.5">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
              <Cpu className="size-3.5 text-primary" /> Decision models
            </div>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">Made for classification. Their probabilities come from the model itself. They run on this Mac or through a hosted service.</p>
          </div>
          <div className="rounded-[14px] bg-card p-3.5">
            <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
              <Sparkles className="size-3.5 text-primary" /> LLMs
            </div>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">General language models such as Claude or GPT. They answer the same questions, show the part of the text they used, and can write free text. They estimate their own probabilities.</p>
          </div>
        </div>

        <div className="mt-6 mb-2 text-[11.5px] font-semibold text-muted-foreground">To use local models, set up the engine:</div>
        <div className="space-y-1.5">
          {steps.map((s, i) => {
            const done = step > i;
            const active = step === i;
            return (
              <div
                key={i}
                className={clsx(
                  "rounded-[14px] p-4 transition-[background-color,box-shadow,opacity] duration-300",
                  active ? "bg-card shadow-[0_0_0_2px_var(--primary)]" : "bg-card/60",
                  !done && !active && "opacity-55",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className={clsx("mt-px grid size-6 shrink-0 place-items-center rounded-full text-[11.5px] font-semibold tnum transition-colors duration-300", done ? "bg-good text-white" : active ? "bg-primary text-primary-foreground" : "bg-sel text-muted-foreground")}>
                    {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
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
                        {pulling ? (
                          <div className="space-y-1.5">
                            <Progress value={pulling.total ? pulling.completed / pulling.total : 0} indeterminate={!pulling.total} />
                            <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
                              <span>{pulling.status}</span>
                              <span>
                                {pulling.total ? `${bytes(pulling.completed)} / ${bytes(pulling.total)}` : ""}
                                {eta !== null && ` · ~${eta < 60 ? `${Math.max(1, Math.round(eta))} s` : `${Math.round(eta / 60)} min`} left`}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button variant="primary" onClick={() => pull(STARTER)} icon={<Download className="size-3.5" />}>
                              Download laya · 1.5 GB
                            </Button>
                            <Button variant="ghost" onClick={() => pull(SMALL)}>
                              Smaller: decima:small · 0.3 GB
                            </Button>
                          </div>
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

        <div className="mt-1.5 rounded-[14px] bg-card/60 p-4">
          <div className="text-[13px] font-semibold">
            Command line tool <span className="font-normal text-faint">· optional</span>
          </div>
          <div className="mt-0.5 mb-2.5 text-[12.5px] leading-relaxed text-muted-foreground">Run checks and evaluations from a terminal with the classifai command.</div>
          {preview ? <Button size="sm">Install command line tool</Button> : <CliInstall compact />}
        </div>

        {step === 3 && (
          <div className="mt-3 flex items-center gap-2 rounded-[12px] bg-good-soft px-3.5 py-2.5 text-[12.5px] text-good fade-up">
            <Check className="size-3.5 shrink-0" strokeWidth={3} />
            Setup is done. You can try a question in the Playground.
          </div>
        )}
        <div className="mt-5 flex items-center gap-2">
          <Button size="sm" icon={<Cloud className="size-3.5" />} onClick={() => go({ page: "models", tab: "cloud" })}>
            Connect a cloud model or LLM
          </Button>
          <Button variant={step === 3 ? "primary" : "ghost"} size="sm" className="ml-auto" onClick={onSkip}>
            {step === 3 ? "Get started" : "Skip for now"} <ArrowRight className="size-3.5" />
          </Button>
        </div>
        <div className="mt-6 flex items-start gap-1.5 text-[11.5px] leading-snug text-faint">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />
          Local models run on this Mac. Cloud models and LLMs receive the text you send them.
        </div>
      </div>
    </div>
  );
}
