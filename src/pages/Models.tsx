import { cn } from "@/lib/utils";
import { Check, Cloud, Cpu, Download, ExternalLink, KeyRound, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, ErrorNote, FormRow, Input, Modal, PageHeader, Progress, Section, Segmented, Spinner, Switch } from "../components/ui";
import { api, errorMessage, openExternal } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { bytes, shortModel, tokens, usd } from "../lib/format";
import type { CloudModel, Provider, ProviderKind } from "../lib/types";

type Tab = "local" | "cloud" | "usage";

export function Models() {
  const [tab, setTab] = useState<Tab>("local");
  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Decision models read a text plus typed questions and return calibrated probabilities."
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "local", label: "On this Mac" },
              { value: "cloud", label: "Cloud" },
              { value: "usage", label: "Usage & cost" },
            ]}
          />
        }
      />
      <div key={tab} className="page-in">
        {tab === "local" && <LocalModels />}
        {tab === "cloud" && <CloudProviders />}
        {tab === "usage" && <Usage />}
      </div>
    </>
  );
}

// ---- local (Ollaya) ------------------------------------------------------------------------------

function LocalModels() {
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
      {!engine?.running && (
        <div className="mb-5">
          <ErrorNote>The engine is not running — start it from the Engine page to manage local models.</ErrorNote>
        </div>
      )}
      <Section title="Installed" subtitle={`${models.length} model${models.length === 1 ? "" : "s"} · ${bytes(models.reduce((a, m) => a + m.size, 0))} on disk`}>
        {models.length === 0 && <div className="text-[12.5px] text-muted-foreground">Nothing installed yet. Pick one from the library below.</div>}
        <div className="divide-y divide-border border-y border-border empty:border-0">
          {models.map((m) => (
            <div key={m.name} className="flex items-center gap-3 py-2.5">
              <Cpu className="size-4 text-faint" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{m.name}</div>
                <div className="text-[11.5px] text-muted-foreground">{[m.details.format, m.details.parameter_size, m.details.quantization_level].filter(Boolean).join(" · ")}</div>
              </div>
              <span className="font-mono text-[12px] text-muted-foreground tnum">{bytes(m.size)}</span>
              <Button variant="danger" size="sm" icon={<Trash2 className="size-3" />} onClick={() => remove(m.name)}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Library"
        subtitle="Curated from Ollaya. Weights download from their authors' Hugging Face repositories."
        actions={
          <>
            <Input className="w-52" placeholder="Any model, e.g. kev:0.8b" value={custom} onChange={setCustom} />
            <Button disabled={!custom.trim() || !engine?.running} icon={<Download className="size-3.5" />} onClick={() => { pull(custom.trim()); setCustom(""); }}>
              Pull
            </Button>
            <Button variant="ghost" icon={<ExternalLink className="size-3" />} onClick={() => openExternal("https://ollaya.dev/search")}>
              Browse
            </Button>
          </>
        }
      >
        {catalog.loading && <Spinner />}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {catalog.data?.map((c) => {
            const have = isInstalled(c.name);
            const p = pulls[c.name];
            return (
              <div key={c.name} className="flex flex-col rounded-[14px] bg-card p-4">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold">{c.title}</span>
                  {c.recommended && (
                    <Badge tone="accent">
                      <Star className="size-2.5" /> Recommended
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11.5px] text-faint">{c.name}</div>
                <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">{c.description}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  <Badge>{c.kind}</Badge>
                  <Badge>{c.params}</Badge>
                  <Badge>~{c.approx_size_gb} GB</Badge>
                  {c.cpu_friendly ? <Badge tone="good">CPU-friendly</Badge> : <Badge tone="warn">GPU recommended</Badge>}
                </div>
                <div className="mt-4">
                  {p ? (
                    <div className="space-y-1">
                      <Progress value={p.total ? p.completed / p.total : 0} indeterminate={!p.total} />
                      <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground">
                        <span className="truncate">{p.status}</span>
                        <span>{p.total ? `${bytes(p.completed)} / ${bytes(p.total)}` : ""}</span>
                      </div>
                    </div>
                  ) : have ? (
                    <div className="flex h-[24px] items-center gap-1.5 text-[12.5px] font-medium text-good">
                      <Check className="size-3.5" strokeWidth={2.5} /> Installed
                    </div>
                  ) : (
                    <Button size="sm" disabled={!engine?.running} icon={<Download className="size-3" />} onClick={() => pull(c.name)}>
                      Download
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}

// ---- cloud providers ------------------------------------------------------------------------------

const PROVIDER_INFO: Record<ProviderKind, { blurb: string; keyUrl?: string; keyLabel: string; needsAccount?: boolean }> = {
  typesafe: { blurb: "Jev, the original hosted System One decision model.", keyUrl: "https://docs.typesafe.ai", keyLabel: "TypeSafe API key" },
  openai: { blurb: "OpenAI's Decisions API: predicates, choices and scores with probabilities.", keyUrl: "https://platform.openai.com/api-keys", keyLabel: "OpenAI API key" },
  cloudflare: { blurb: "Clef and Clef-Flash on Workers AI, billed to your Cloudflare account.", keyUrl: "https://dash.cloudflare.com/profile/api-tokens", keyLabel: "API token (Workers AI)", needsAccount: true },
  custom: { blurb: "Any TypeSafe-compatible endpoint: OpenRouter, Vercel AI Gateway, a remote Ollaya…", keyLabel: "API key (optional)" },
};

function CloudProviders() {
  const { providers, refreshProviders } = useApp();
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [addingModel, setAddingModel] = useState<Provider | null>(null);

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4 rounded-[12px] bg-card px-4 py-3 text-[12.5px] text-muted-foreground">
        <span>
          Cloud models are used like local ones — in Quick Check and experiments. Requests send the input text to the provider. Keys are stored in your macOS Keychain.
        </span>
        <Button size="sm" icon={<Plus className="size-3" />} onClick={() => setEditing("new")}>
          Custom endpoint
        </Button>
      </div>

      {providers.length === 0 && <Spinner />}
      {providers.map((p) => (
        <ProviderBlock key={p.id} p={p} onEdit={() => setEditing(p)} onAddModel={() => setAddingModel(p)} onChanged={refreshProviders} />
      ))}

      <ProviderSheet provider={editing} onClose={() => setEditing(null)} onSaved={refreshProviders} />
      <AddModelSheet provider={addingModel} onClose={() => setAddingModel(null)} onSaved={refreshProviders} />
    </>
  );
}

function ProviderBlock({ p, onEdit, onAddModel, onChanged }: { p: Provider; onEdit: () => void; onAddModel: () => void; onChanged: () => void }) {
  const { toast } = useApp();
  const info = PROVIDER_INFO[p.kind];
  const ready = p.has_key || p.kind === "custom";
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const runTest = async () => {
    setTesting(true);
    try {
      setTest(await api.providerTest(p.id));
    } catch (e) {
      setTest({ ok: false, message: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Cloud className="size-4 text-faint" />
          {p.name}
          {ready ? (
            <Badge tone="good">
              <Check className="size-2.5" strokeWidth={3} /> Connected{p.key_hint ? ` · ${p.key_hint}` : ""}
            </Badge>
          ) : (
            <Badge>Not connected</Badge>
          )}
        </span>
      }
      subtitle={info.blurb}
      actions={
        <>
          {test && <span className={cn("text-[12px] fade-up", test.ok ? "text-good" : "text-bad")}>{test.message}</span>}
          {ready && (
            <Button size="sm" variant="ghost" loading={testing} onClick={runTest}>
              Test
            </Button>
          )}
          <Button size="sm" variant={ready ? "secondary" : "primary"} icon={<KeyRound className="size-3" />} onClick={onEdit}>
            {ready ? "Edit" : "Connect"}
          </Button>
        </>
      }
    >
      <div className="divide-y divide-border border-y border-border">
        {p.models.map((m) => (
          <CloudModelRow key={m.id} m={m} disabled={!ready} onChanged={onChanged} onError={(e) => toast(e, "bad")} />
        ))}
        {p.models.length === 0 && <div className="py-3 text-[12.5px] text-muted-foreground">No models yet.</div>}
      </div>
      <div className="mt-2">
        <Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={onAddModel}>
          Add model
        </Button>
      </div>
    </Section>
  );
}

/** One cloud model: enable toggle and inline-editable prices (saved on blur). */
function CloudModelRow({ m, disabled, onChanged, onError }: { m: CloudModel; disabled: boolean; onChanged: () => void; onError: (e: string) => void }) {
  const [inPrice, setIn] = useState(String(m.input_price_per_mtok));
  const [outPrice, setOut] = useState(String(m.output_price_per_mtok));
  useEffect(() => {
    setIn(String(m.input_price_per_mtok));
    setOut(String(m.output_price_per_mtok));
  }, [m.input_price_per_mtok, m.output_price_per_mtok]);

  const save = async (patch: Partial<{ enabled: boolean; input: number; output: number }>) => {
    try {
      await api.cloudModelSave({
        provider_id: m.provider_id,
        model: m.model,
        display_name: m.display_name,
        input_price_per_mtok: patch.input ?? m.input_price_per_mtok,
        output_price_per_mtok: patch.output ?? m.output_price_per_mtok,
        enabled: patch.enabled ?? m.enabled,
      });
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    }
  };
  const commit = (which: "input" | "output", raw: string) => {
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) return;
    if ((which === "input" ? m.input_price_per_mtok : m.output_price_per_mtok) !== v) save({ [which]: v });
  };

  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 py-2.5 transition-opacity", disabled && "opacity-50")}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{m.display_name}</span>
          <span className="font-mono text-[11px] text-faint">{m.id}</span>
        </div>
        {m.description && <div className="truncate text-[11.5px] text-muted-foreground">{m.description}</div>}
      </div>
      <PriceField label="in" value={inPrice} onChange={setIn} onCommit={(v) => commit("input", v)} />
      <PriceField label="out" value={outPrice} onChange={setOut} onCommit={(v) => commit("output", v)} />
      <Switch checked={m.enabled} onChange={(enabled) => save({ enabled })} />
      {!m.builtin ? (
        <Button
          variant="ghost"
          size="icon"
          title="Remove model"
          icon={<Trash2 className="size-3.5" />}
          onClick={async () => {
            await api.cloudModelDelete(m.id);
            onChanged();
          }}
        />
      ) : (
        <span className="w-[28px]" />
      )}
    </div>
  );
}

function PriceField({ label, value, onChange, onCommit }: { label: string; value: string; onChange: (v: string) => void; onCommit: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1 text-[11.5px] text-muted-foreground" title={`USD per 1M ${label === "in" ? "input" : "output"} tokens`}>
      $
      <input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="h-[24px] w-[60px] rounded-[7px] border border-border bg-background px-1.5 text-right font-mono text-[12px] text-foreground outline-none transition-[border-color,box-shadow] focus:border-primary focus:ring-[3px] focus:ring-ring"
      />
      <span className="w-12">/M {label}</span>
    </label>
  );
}

function ProviderSheet({ provider, onClose, onSaved }: { provider: Provider | "new" | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const isNew = provider === "new";
  const p = isNew ? null : provider;
  const kind: ProviderKind = p?.kind ?? "custom";
  const info = PROVIDER_INFO[kind];
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [account, setAccount] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(p?.name ?? "");
    setBaseUrl(p?.base_url ?? "");
    setAccount(p?.account_id ?? "");
    setKey("");
    setError(null);
  }, [provider, p]);

  const save = async (removeKey = false) => {
    setBusy(true);
    setError(null);
    try {
      await api.providerSave({
        id: p?.id ?? null,
        kind,
        name: name.trim() || p?.name || "Custom endpoint",
        base_url: baseUrl.trim() || null,
        account_id: account.trim() || null,
        api_key: removeKey ? "" : key.trim() || null,
      });
      toast(removeKey ? "Key removed" : `${name || p?.name} saved`, "good");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canSave = kind === "custom" ? !!baseUrl.trim() && !!name.trim() : !!key.trim() || (!!p?.has_key && (!info.needsAccount || !!account.trim()));

  return (
    <Modal
      open={provider !== null}
      onClose={onClose}
      width={460}
      title={isNew ? "Add a TypeSafe-compatible endpoint" : `Connect ${p?.name}`}
      footer={
        <>
          {p?.has_key && (
            <Button variant="danger" className="mr-auto" onClick={() => save(true)}>
              Remove key
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} loading={busy} onClick={() => save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="-ml-3 space-y-0.5">
        {kind === "custom" && (
          <>
            <FormRow label="Name:" labelWidth={110}>
              <Input value={name} onChange={setName} placeholder="OpenRouter" />
            </FormRow>
            <FormRow label="Base URL:" labelWidth={110} hint="ClassifAI calls {base}/v1/systemone.">
              <Input mono value={baseUrl} onChange={setBaseUrl} placeholder="https://openrouter.ai/api" />
            </FormRow>
          </>
        )}
        {info.needsAccount && (
          <FormRow label="Account ID:" labelWidth={110}>
            <Input mono value={account} onChange={setAccount} placeholder="32-character Cloudflare account id" />
          </FormRow>
        )}
        <FormRow
          label="API key:"
          labelWidth={110}
          hint={
            <>
              {p?.has_key ? `A key ending ${p.key_hint} is saved. Leave empty to keep it.` : "Stored in your macOS Keychain, never in the project database."}
              {info.keyUrl && (
                <button className="ml-1 text-primary hover:underline" onClick={() => openExternal(info.keyUrl!)}>
                  Get a key ↗
                </button>
              )}
            </>
          }
        >
          <Input type="password" value={key} onChange={setKey} placeholder={info.keyLabel} autoFocus />
        </FormRow>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Modal>
  );
}

function AddModelSheet({ provider, onClose, onSaved }: { provider: Provider | null; onClose: () => void; onSaved: () => void }) {
  const [model, setModel] = useState("");
  const [display, setDisplay] = useState("");
  const [inPrice, setIn] = useState("0");
  const [outPrice, setOut] = useState("0");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setModel("");
    setDisplay("");
    setIn("0");
    setOut("0");
    setError(null);
  }, [provider]);

  const save = async () => {
    if (!provider) return;
    try {
      await api.cloudModelSave({ provider_id: provider.id, model: model.trim(), display_name: display.trim() || null, input_price_per_mtok: Number(inPrice) || 0, output_price_per_mtok: Number(outPrice) || 0, enabled: true });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Modal
      open={provider !== null}
      onClose={onClose}
      title={`Add a model to ${provider?.name ?? ""}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!model.trim()} onClick={save}>
            Add
          </Button>
        </>
      }
    >
      <div className="-ml-3 space-y-0.5">
        <FormRow label="Model name:" labelWidth={120} hint="Exactly as the provider expects it in requests.">
          <Input mono value={model} onChange={setModel} placeholder="jev-latest" autoFocus />
        </FormRow>
        <FormRow label="Display name:" labelWidth={120}>
          <Input value={display} onChange={setDisplay} placeholder="optional" />
        </FormRow>
        <FormRow label="Input price:" labelWidth={120} hint="USD per 1M tokens, used for cost monitoring.">
          <Input mono className="max-w-[8rem]" value={inPrice} onChange={setIn} />
        </FormRow>
        <FormRow label="Output price:" labelWidth={120}>
          <Input mono className="max-w-[8rem]" value={outPrice} onChange={setOut} />
        </FormRow>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </Modal>
  );
}

// ---- usage & cost ----------------------------------------------------------------------------------

type Range = "7d" | "30d" | "all";

function Usage() {
  const [range, setRange] = useState<Range>("30d");
  const since = useMemo(() => (range === "all" ? undefined : new Date(Date.now() - (range === "7d" ? 7 : 30) * 864e5).toISOString()), [range]);
  const usage = useAsync(() => api.usageSummary(since), [since]);
  const rows = usage.data ?? [];
  const total = rows.reduce((a, r) => a + r.cost_usd, 0);
  const max = Math.max(...rows.map((r) => r.cost_usd), 1e-12);

  return (
    <>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-[11px] font-medium text-faint">Estimated spend</div>
          <div className="text-[28px] font-bold tracking-[-0.02em] tnum">{usd(total)}</div>
          <div className="text-[12px] text-muted-foreground">Computed from the prices you set per model. Local models are free.</div>
        </div>
        <Segmented
          value={range}
          onChange={setRange}
          options={[
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
            { value: "all", label: "All time" },
          ]}
        />
      </div>
      {usage.loading && !usage.data ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <div className="text-[12.5px] text-muted-foreground">No requests yet in this period.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead className="border-b border-border text-[11.5px] text-faint">
            <tr>
              <th className="py-2 text-left font-medium">Model</th>
              <th className="py-2 text-right font-medium">Requests</th>
              <th className="py-2 text-right font-medium">Input tokens</th>
              <th className="py-2 text-right font-medium">Output tokens</th>
              <th className="w-[30%] py-2 pl-6 text-left font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model} className="border-b border-border/60">
                <td className="py-2.5">
                  <span className="flex items-center gap-1.5">
                    {r.model.startsWith("@") ? <Cloud className="size-3 text-faint" /> : <Cpu className="size-3 text-faint" />}
                    {shortModel(r.model)}
                    <span className="font-mono text-[11px] text-faint">{r.model.startsWith("@") ? r.model.split("/")[0].slice(1) : "local"}</span>
                  </span>
                </td>
                <td className="py-2.5 text-right font-mono text-[12px] tnum">{r.requests.toLocaleString()}</td>
                <td className="py-2.5 text-right font-mono text-[12px] tnum">{tokens(r.input_tokens)}</td>
                <td className="py-2.5 text-right font-mono text-[12px] tnum">{tokens(r.output_tokens)}</td>
                <td className="py-2.5 pl-6">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sel">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${(r.cost_usd / max) * 100}%` }} />
                    </div>
                    <span className="w-16 text-right font-mono text-[12px] tnum">{usd(r.cost_usd)}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
