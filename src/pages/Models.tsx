import clsx from "clsx";
import { Check, Cpu, Download, ExternalLink, Gauge, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, ErrorNote, Input, PageHeader, Progress, Spinner } from "../components/ui";
import { api, errorMessage } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { bytes, shortModel } from "../lib/format";

export function Models() {
  const { models, pulls, pull, refreshModels, toast, engine } = useApp();
  const catalog = useAsync(() => api.modelsCatalog(), []);
  const [custom, setCustom] = useState("");
  const installedNames = new Set(models.map((m) => m.name));
  const isInstalled = (n: string) => installedNames.has(n) || installedNames.has(`${n}:latest`);

  const remove = async (name: string) => {
    try {
      await api.modelDelete(name);
      toast(`Removed ${shortModel(name)}`);
      refreshModels();
    } catch (e) {
      toast(errorMessage(e), "bad");
    }
  };

  return (
    <>
      <PageHeader title="Models" subtitle="Decision models read a text plus typed questions and return calibrated probabilities in one forward pass." />
      {!engine?.running && <div className="mb-4"><ErrorNote>The engine is not running — start it from the Engine page to manage models.</ErrorNote></div>}

      <Card className="mb-5">
        <CardHeader title="Installed" subtitle={`${models.length} model${models.length === 1 ? "" : "s"} · ${bytes(models.reduce((a, m) => a + m.size, 0))} on disk`} />
        <div className="border-t border-line">
          {models.length === 0 && <div className="px-5 py-6 text-[12.5px] text-muted">Nothing installed yet. Pick one from the library below.</div>}
          {models.map((m) => (
            <div key={m.name} className="flex items-center gap-4 border-b border-line px-5 py-3 last:border-0">
              <div className="grid size-8 place-items-center rounded-lg bg-panel-2 text-muted">
                <Cpu className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{m.name}</div>
                <div className="text-[11.5px] text-muted">
                  {[m.details.format, m.details.parameter_size, m.details.quantization_level].filter(Boolean).join(" · ")}
                </div>
              </div>
              <span className="font-mono text-[12px] text-muted tnum">{bytes(m.size)}</span>
              <Button variant="danger" size="sm" icon={<Trash2 className="size-3.5" />} onClick={() => remove(m.name)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[15px] font-semibold tracking-[-0.01em]">Library</div>
          <div className="text-[12.5px] text-muted">A curated selection from Ollaya. Weights download from the authors' Hugging Face repos.</div>
        </div>
        <div className="flex items-center gap-2">
          <Input className="w-56" placeholder="Any model, e.g. kev:0.8b" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <Button disabled={!custom.trim() || !engine?.running} icon={<Download className="size-3.5" />} onClick={() => { pull(custom.trim()); setCustom(""); }}>
            Pull
          </Button>
          <a href="https://ollaya.dev/search" target="_blank" rel="noreferrer" className="flex h-8.5 items-center gap-1 whitespace-nowrap px-2 text-[12.5px] text-muted hover:text-fg">
            Browse all <ExternalLink className="size-3" />
          </a>
        </div>
      </div>

      {catalog.loading && <Spinner />}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {catalog.data?.map((c) => {
          const have = isInstalled(c.name);
          const p = pulls[c.name];
          return (
            <Card key={c.name} className={clsx("flex flex-col p-4", c.recommended && "border-accent/40")}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-semibold">{c.title}</span>
                    {c.recommended && (
                      <Badge tone="accent">
                        <Star className="size-2.5" /> Recommended
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-faint">{c.name}</div>
                </div>
              </div>
              <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-muted">{c.description}</p>
              <div className="mt-3 flex flex-wrap gap-1">
                <Badge>{c.kind}</Badge>
                <Badge>{c.params}</Badge>
                <Badge>~{c.approx_size_gb} GB</Badge>
                {c.cpu_friendly ? (
                  <Badge tone="good">
                    <Gauge className="size-2.5" /> CPU-friendly
                  </Badge>
                ) : (
                  <Badge tone="warn">GPU recommended</Badge>
                )}
              </div>
              <div className="mt-4">
                {p ? (
                  <div className="space-y-1">
                    <Progress value={p.total ? p.completed / p.total : 0} indeterminate={!p.total} />
                    <div className="flex justify-between font-mono text-[10.5px] text-muted">
                      <span className="truncate">{p.status}</span>
                      <span>{p.total ? `${bytes(p.completed)} / ${bytes(p.total)}` : ""}</span>
                    </div>
                  </div>
                ) : have ? (
                  <div className="flex h-7 items-center gap-1.5 text-[12.5px] font-medium text-good">
                    <Check className="size-3.5" strokeWidth={2.5} /> Installed
                  </div>
                ) : (
                  <Button size="sm" disabled={!engine?.running} icon={<Download className="size-3.5" />} onClick={() => pull(c.name)}>
                    Download
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
