import { Download, Play, RefreshCw, Square, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, ErrorNote, PageHeader } from "../components/ui";
import { api, errorMessage, events } from "../lib/api";
import { useApp, useAsync } from "../lib/app";

export function EnginePage() {
  const { engine, refreshEngine, refreshModels, go } = useApp();
  const info = useAsync(() => api.appInfo(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    const un = events.installLog((l) => setLog((x) => [...x.slice(-300), l]));
    return () => void un.then((f) => f());
  }, []);

  const act = async (kind: string, fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      await refreshEngine();
      await refreshModels();
      setBusy(null);
    }
  };

  const rows: [string, React.ReactNode][] = [
    ["Status", engine?.running ? <Badge tone="good">Running</Badge> : engine?.installed ? <Badge tone="warn">Stopped</Badge> : <Badge tone="bad">Not installed</Badge>],
    ["Version", engine?.version ?? "—"],
    ["API", <span className="font-mono">{engine?.base_url}</span>],
    ["Binary", <span className="font-mono text-[11.5px]">{engine?.binary_path ?? "—"}</span>],
    ["Managed by ClassifAI", engine?.managed ? "Yes — installed into the app folder" : engine?.installed ? "No — using a system install" : "—"],
    ["Started by this app", engine?.owned_process ? "Yes — stops when ClassifAI quits" : engine?.running ? "No — an external daemon" : "—"],
    ["App data", <span className="font-mono text-[11.5px]">{info.data?.data_dir}</span>],
  ];

  return (
    <>
      <PageHeader title="Engine" subtitle="ClassifAI uses Ollaya to run decision models locally." />
      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
      <Card>
        <CardHeader
          title="Ollaya"
          actions={
            <>
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={() => refreshEngine()}>
                Refresh
              </Button>
              {!engine?.installed && (
                <Button size="sm" variant="primary" loading={busy === "install"} icon={<Download className="size-3.5" />} onClick={() => act("install", api.engineInstall)}>
                  Install
                </Button>
              )}
              {engine?.installed && !engine.running && (
                <Button size="sm" variant="primary" loading={busy === "start"} icon={<Play className="size-3.5" />} onClick={() => act("start", api.engineStart)}>
                  Start
                </Button>
              )}
              {engine?.running && engine.owned_process && (
                <Button size="sm" loading={busy === "stop"} icon={<Square className="size-3" />} onClick={() => act("stop", api.engineStop)}>
                  Stop
                </Button>
              )}
              {engine?.managed && (
                <Button size="sm" loading={busy === "install"} icon={<Download className="size-3.5" />} onClick={() => act("install", api.engineInstall)}>
                  Update
                </Button>
              )}
            </>
          }
        />
        <dl className="border-t border-line">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[200px_1fr] border-b border-line px-5 py-2.5 text-[13px] last:border-0">
              <dt className="text-muted">{k}</dt>
              <dd data-selectable>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {log.length > 0 && (
        <Card className="mt-5">
          <CardHeader title={<span className="flex items-center gap-2"><Terminal className="size-3.5" /> Installer output</span>} />
          <div className="mx-5 mb-5 max-h-64 overflow-auto rounded-lg bg-[#0d0d12] p-3 font-mono text-[11px] leading-relaxed text-zinc-300" data-selectable>
            {log.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </Card>
      )}

      <div className="mt-5 text-[12px] text-faint">
        Prefer your own install? ClassifAI uses any Ollaya on PATH or a daemon already listening on <span className="font-mono">127.0.0.1:11435</span> (set <span className="font-mono">OLLAYA_HOST</span> to change). <button className="underline hover:text-fg" onClick={() => go({ page: "models" })}>Manage models →</button>
      </div>
    </>
  );
}
