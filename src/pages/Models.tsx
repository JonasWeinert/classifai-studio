import { cn } from "@/lib/utils";
import { Check, Cpu, Download, ExternalLink, KeyRound, Plus, RotateCcw, Star, Trash2 } from "lucide-react";
import { ModelIcon, ProviderIcon } from "../components/ProviderLogo";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, ErrorNote, FormRow, Input, Modal, PageHeader, Progress, SearchField, Section, Segmented, Spinner, Switch, Tooltip } from "../components/ui";
import { api, errorMessage, openExternal } from "../lib/api";
import { useApp, useAsync } from "../lib/app";
import { bytes, shortModel, tokens, usd } from "../lib/format";
import type { CloudModel, Provider, ProviderKind, RemoteModel, TrackRecord } from "../lib/types";
import { isConnected, isLlmKind } from "../lib/models";

type Tab = "local" | "cloud" | "usage";

export function Models() {
  const { route, go, budget } = useApp();
  const tab: Tab = route.page === "models" && route.tab ? route.tab : "local";
  const setTab = (t: Tab) => go({ page: "models", tab: t });
  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Decision models and LLMs read a text plus typed questions and return probabilities."
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
      {budget && budget.ratio !== null && budget.ratio >= 0.8 && (
        <div className={cn("mb-6 flex items-center justify-between rounded-[12px] px-4 py-2.5 text-[12.5px]", budget.exceeded ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn")}>
          <span>
            {budget.exceeded ? "This month's cloud budget is used up." : `You've used ${Math.round(budget.ratio * 100)}% of this month's cloud budget.`} {usd(budget.month_spend_usd)} of {usd(budget.budget_usd ?? 0)}.
          </span>
          <button className="font-medium hover:underline" onClick={() => go({ page: "settings", tab: "accounts" })}>
            Budget settings
          </button>
        </div>
      )}
      <div key={tab} className="page-in">
        {tab === "local" && <LocalModels />}
        {tab === "cloud" && <CloudProviders />}
        {tab === "usage" && <Usage />}
      </div>
    </>
  );
}

// ---- local (Ollaya) ------------------------------------------------------------------------------

// One shared request for all rows; refreshed at most every 30 s.
let trackCache: { at: number; p: Promise<TrackRecord[]> } | null = null;
const loadTrack = () => {
  if (!trackCache || Date.now() - trackCache.at > 30_000) trackCache = { at: Date.now(), p: api.trackRecord() };
  return trackCache.p;
};

/** Best result each model reached on the user's own experiments, keyed by model id. */
function useTrackRecord() {
  const t = useAsync(loadTrack, []);
  return useMemo(() => {
    const m = new Map<string, TrackRecord>();
    for (const r of t.data ?? []) {
      const key = r.model.replace(/:latest$/, "");
      if (!m.has(key)) m.set(key, r);
    }
    return m;
  }, [t.data]);
}

function TrackBadge({ r }: { r?: TrackRecord }) {
  const { go } = useApp();
  if (!r) return null;
  return (
    <button onClick={() => go({ page: "experiment", id: r.experiment_id })} className="inline-flex h-[18px] items-center gap-1 rounded-full bg-good-soft px-2 text-[11px] font-medium text-good hover:underline" title={`Best on your data: ${r.experiment_name} · ${r.question_id}`}>
      Your data: F1 {r.macro_f1.toFixed(2)}
    </button>
  );
}

function LocalModels() {
  const { models, pulls, pull, refreshModels, toast, engine } = useApp();
  const track = useTrackRecord();
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
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {m.name}
                  {m.details.family === "fine-tune" && <Badge tone="accent">Fine-tuned</Badge>}
                  <TrackBadge r={track.get(m.name.replace(/:latest$/, ""))} />
                </div>
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
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
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[11.5px] text-faint">
                  {c.name}
                  <TrackBadge r={track.get(c.name)} />
                </div>
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
  anthropic: { blurb: "Claude models, answering through a structured tool call.", keyUrl: "https://console.anthropic.com/settings/keys", keyLabel: "Anthropic API key" },
  chat: { blurb: "An OpenAI-compatible chat API, answering through a JSON schema.", keyLabel: "API key (optional for local servers)" },
};

/** Ready-made OpenAI-compatible LLM endpoints for "Add LLM provider". */
const CHAT_PRESETS: { name: string; url: string; hint: string; keyUrl?: string }[] = [
  { name: "OpenRouter", url: "https://openrouter.ai/api", hint: "Hundreds of models behind one key", keyUrl: "https://openrouter.ai/settings/keys" },
  { name: "Ollama", url: "http://localhost:11434", hint: "Open models on this Mac, no key" },
  { name: "LM Studio", url: "http://localhost:1234", hint: "Open models on this Mac, no key" },
  { name: "Groq", url: "https://api.groq.com/openai", hint: "Very fast open models", keyUrl: "https://console.groq.com/keys" },
  { name: "Other", url: "", hint: "Any server with /v1/chat/completions" },
];

type Editing = Provider | { add: ProviderKind } | null;

function CloudProviders() {
  const { providers, refreshProviders } = useApp();
  const [editing, setEditing] = useState<Editing>(null);
  const [addingModel, setAddingModel] = useState<Provider | null>(null);
  const decision = providers.filter((p) => !isLlmKind(p.kind));
  const llms = providers.filter((p) => isLlmKind(p.kind));

  return (
    <>
      <div className="mb-6 rounded-[12px] bg-card px-4 py-3 text-[12.5px] text-muted-foreground">
        Cloud models are used like local ones — in Playground, Bulk and evaluations. Requests send the input text to the provider. Keys are stored in your macOS Keychain.
      </div>

      {providers.length === 0 && <Spinner />}
      {providers.length > 0 && (
        <>
          <GroupHeader
            title="Decision models"
            blurb="Built to classify: they read the input and return probabilities from the model itself, usually well calibrated. They can't write free text."
            action={
              <Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setEditing({ add: "custom" })}>
                Custom endpoint
              </Button>
            }
          />
          {decision.map((p) => (
            <ProviderBlock key={p.id} p={p} onEdit={() => setEditing(p)} onAddModel={() => setAddingModel(p)} onChanged={refreshProviders} />
          ))}
          <GroupHeader
            title={
              <span className="flex items-center gap-2">
                LLMs <Badge tone="accent">structured output</Badge>
              </span>
            }
            blurb={
              <>
                Large language models answer the same questions by filling a JSON schema, and also answer <b className="font-medium text-foreground">free-text</b> questions. Their probabilities are the
                model's own estimates, so they tend to be less calibrated than a decision model's — an evaluation shows how far to trust them. Slower and usually pricier per entry.
              </>
            }
            action={
              <Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setEditing({ add: "chat" })}>
                LLM provider
              </Button>
            }
          />
          {llms.map((p) => (
            <ProviderBlock key={p.id} p={p} onEdit={() => setEditing(p)} onAddModel={() => setAddingModel(p)} onChanged={refreshProviders} />
          ))}
        </>
      )}

      <ProviderSheet provider={editing} onClose={() => setEditing(null)} onSaved={refreshProviders} />
      <AddModelSheet provider={addingModel} onClose={() => setAddingModel(null)} onSaved={refreshProviders} />
    </>
  );
}

/** "Decision models" / "LLMs" above their providers. */
function GroupHeader({ title, blurb, action }: { title: React.ReactNode; blurb: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mt-2 mb-4 flex items-end justify-between gap-6 border-b border-border pb-2 first:mt-0">
      <div>
        <div className="text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
        <div className="mt-0.5 max-w-[46rem] text-[12.5px] leading-relaxed text-muted-foreground">{blurb}</div>
      </div>
      {action}
    </div>
  );
}

function ProviderBlock({ p, onEdit, onAddModel, onChanged }: { p: Provider; onEdit: () => void; onAddModel: () => void; onChanged: () => void }) {
  const { toast } = useApp();
  const info = PROVIDER_INFO[p.kind];
  const ready = isConnected(p);
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
          <ProviderIcon p={p} className="size-4 text-muted-foreground" />
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
  const track = useTrackRecord();
  const isDefault = m.default_input_price_per_mtok == null || (m.default_input_price_per_mtok === m.input_price_per_mtok && (m.default_output_price_per_mtok ?? 0) === m.output_price_per_mtok);
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
          <TrackBadge r={track.get(m.id)} />
        </div>
        {m.description && <div className="truncate text-[11.5px] text-muted-foreground">{m.description}</div>}
      </div>
      <PriceField label="in" value={inPrice} onChange={setIn} onCommit={(v) => commit("input", v)} />
      <div className="flex items-center">
        <PriceField label="out" value={outPrice} onChange={setOut} onCommit={(v) => commit("output", v)} />
        <Tooltip content={isDefault ? "Published price (Oct 2026)" : "Reset to the published price"}>
          <button
            disabled={isDefault}
            onClick={() => save({ input: m.default_input_price_per_mtok ?? m.input_price_per_mtok, output: m.default_output_price_per_mtok ?? 0 })}
            className="ml-1 grid size-6 place-items-center rounded-full text-faint hover:bg-sel hover:text-foreground disabled:opacity-40"
            aria-label="Reset price"
          >
            <RotateCcw className="size-3" />
          </button>
        </Tooltip>
      </div>
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

function ProviderSheet({ provider, onClose, onSaved }: { provider: Editing; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const isNew = !!provider && "add" in provider;
  const p = provider && !("add" in provider) ? provider : null;
  const kind: ProviderKind = p?.kind ?? (provider && "add" in provider ? provider.add : "custom");
  const [preset, setPreset] = useState<string | null>(null);
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
    setPreset(null);
  }, [provider, p]);

  const save = async (removeKey = false) => {
    setBusy(true);
    setError(null);
    try {
      await api.providerSave({
        id: p?.id ?? null,
        kind,
        name: name.trim() || p?.name || (kind === "chat" ? "LLM endpoint" : "Custom endpoint"),
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

  const canSave =
    kind === "custom" || (kind === "chat" && (isNew || !p?.builtin))
      ? !!baseUrl.trim() && !!name.trim()
      : kind === "chat"
        ? true
        : !!key.trim() || (!!p?.has_key && (!info.needsAccount || !!account.trim()));
  const keyUrl = CHAT_PRESETS.find((x) => x.name === preset)?.keyUrl ?? info.keyUrl;

  return (
    <Modal
      open={provider !== null}
      onClose={onClose}
      width={460}
      title={isNew ? (kind === "chat" ? "Add an LLM provider" : "Add a TypeSafe-compatible endpoint") : `Connect ${p?.name}`}
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
      {isNew && kind === "chat" && (
        <div className="mb-3">
          <div className="mb-1.5 text-[12px] text-muted-foreground">Any server that speaks OpenAI's chat API and supports JSON output works.</div>
          <div className="grid grid-cols-2 gap-1.5">
            {CHAT_PRESETS.map((x) => (
              <button
                key={x.name}
                onClick={() => {
                  setPreset(x.name);
                  if (x.name !== "Other") setName(x.name);
                  setBaseUrl(x.url);
                }}
                className={cn("rounded-[10px] px-3 py-2 text-left transition-colors", preset === x.name ? "bg-primary text-primary-foreground" : "bg-sel hover:bg-sel/70")}
              >
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium">
                  {x.name !== "Other" && <ProviderIcon p={{ kind: "custom", base_url: x.url }} className="size-3.5" />}
                  {x.name}
                </div>
                <div className={cn("text-[11px]", preset === x.name ? "text-primary-foreground/80" : "text-faint")}>{x.hint}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="-ml-3 space-y-0.5">
        {kind === "chat" && (isNew || !p?.builtin) && (
          <>
            <FormRow label="Name:" labelWidth={110}>
              <Input value={name} onChange={setName} placeholder="OpenRouter" />
            </FormRow>
            <FormRow label="Base URL:" labelWidth={110} hint="ClassifAI Studio calls {base}/v1/chat/completions.">
              <Input mono value={baseUrl} onChange={setBaseUrl} placeholder="https://openrouter.ai/api" />
            </FormRow>
          </>
        )}
        {kind === "custom" && (
          <>
            <FormRow label="Name:" labelWidth={110}>
              <Input value={name} onChange={setName} placeholder="OpenRouter" />
            </FormRow>
            <FormRow label="Base URL:" labelWidth={110} hint="ClassifAI Studio calls {base}/v1/systemone.">
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
              {keyUrl && (
                <button className="ml-1 text-primary hover:underline" onClick={() => openExternal(keyUrl)}>
                  Get a key ↗
                </button>
              )}
            </>
          }
        >
          <Input type="password" value={key} onChange={setKey} placeholder={info.keyLabel} autoFocus={!isNew} />
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

/** Most listed models drawn at once; the search narrows the rest. */
const LIST_LIMIT = 200;

/**
 * Add a model: search the provider's own model list (name, id, description) and pick one — its
 * name, display name and published prices fill in. Providers without a list (or offline ones)
 * fall back to typing the model name.
 */
function AddModelSheet({ provider, onClose, onSaved }: { provider: Provider | null; onClose: () => void; onSaved: () => void }) {
  const [model, setModel] = useState("");
  const [display, setDisplay] = useState("");
  const [inPrice, setIn] = useState("0");
  const [outPrice, setOut] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [list, setList] = useState<{ loading: boolean; models: RemoteModel[]; error: string | null }>({ loading: false, models: [], error: null });
  const llm = !!provider && isLlmKind(provider.kind);

  useEffect(() => {
    setModel("");
    setDisplay("");
    setIn("0");
    setOut("0");
    setError(null);
    setQuery("");
    setManual(provider?.kind === "cloudflare");
    if (!provider || provider.kind === "cloudflare") return setList({ loading: false, models: [], error: null });
    setList({ loading: true, models: [], error: null });
    let live = true;
    api
      .providerModels(provider.id)
      .then((models) => live && setList({ loading: false, models, error: null }))
      .catch((e) => {
        if (!live) return;
        setList({ loading: false, models: [], error: errorMessage(e) });
        setManual(true);
      });
    return () => {
      live = false;
    };
  }, [provider]);

  const added = new Set(provider?.models.map((m) => m.model) ?? []);
  const hits = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return list.models.filter((m) => {
      const hay = `${m.id} ${m.name} ${m.description ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [list.models, query]);

  const pick = (m: RemoteModel) => {
    setModel(m.id);
    setDisplay(m.name !== m.id ? m.name.replace(/^[^:]{1,30}:\s*/, "") : "");
    if (m.input_price_per_mtok != null) setIn(String(m.input_price_per_mtok));
    if (m.output_price_per_mtok != null) setOut(String(m.output_price_per_mtok));
  };

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

  const chosen = list.models.find((m) => m.id === model);
  const searching = !manual && !list.error;

  return (
    <Modal
      open={provider !== null}
      onClose={onClose}
      width={searching ? 560 : undefined}
      title={`Add a model to ${provider?.name ?? ""}`}
      footer={
        <>
          {list.models.length > 0 && (
            <Button variant="ghost" className="mr-auto" onClick={() => setManual(!manual)}>
              {manual ? "Search the list" : "Enter a name instead"}
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!model.trim() || added.has(model.trim())} onClick={save}>
            {added.has(model.trim()) ? "Already added" : "Add"}
          </Button>
        </>
      }
    >
      {searching && (
        <div className="mb-3">
          <SearchField className="w-full" value={query} onChange={setQuery} placeholder={list.loading ? "Loading models…" : `Search ${list.models.length.toLocaleString()} models`} />
          <div className="mt-2 max-h-[300px] min-h-[120px] overflow-y-auto rounded-[10px] border border-border">
            {list.loading ? (
              <div className="grid min-h-[118px] place-items-center">
                <Spinner />
              </div>
            ) : hits.length === 0 ? (
              <div className="grid min-h-[118px] place-items-center px-6 text-center text-[12.5px] text-muted-foreground">{list.models.length ? `No model matches “${query}”.` : "This provider lists no models."}</div>
            ) : (
              <>
                {hits.slice(0, LIST_LIMIT).map((m) => {
                  const on = m.id === model;
                  const has = added.has(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => pick(m)}
                      disabled={has}
                      className={cn("flex w-full items-start gap-3 border-b border-border/60 px-3 py-2 text-left last:border-0", on ? "bg-primary/10" : "hover:bg-sel", has && "opacity-50")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate text-[13px] font-medium">{m.name}</span>
                          {m.name !== m.id && <span className="truncate font-mono text-[11px] text-faint">{m.id}</span>}
                        </span>
                        {m.description && <span className="mt-0.5 line-clamp-1 block text-[11.5px] text-muted-foreground">{m.description}</span>}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11px] text-faint">
                        {has ? (
                          <span>added</span>
                        ) : m.input_price_per_mtok != null ? (
                          <span className="font-mono tnum">
                            ${m.input_price_per_mtok} / ${m.output_price_per_mtok ?? 0}
                          </span>
                        ) : null}
                        {llm && m.structured_output === false && <span className="text-warn" title="The provider says this model doesn't support JSON-schema output; answers may fail">no JSON schema</span>}
                        {m.context_length ? <span className="tnum">{m.context_length >= 1000 ? `${Math.round(m.context_length / 1000)}k` : m.context_length} ctx</span> : null}
                      </span>
                    </button>
                  );
                })}
                {hits.length > LIST_LIMIT && <div className="px-3 py-2 text-[11.5px] text-faint">{(hits.length - LIST_LIMIT).toLocaleString()} more — search to narrow down.</div>}
              </>
            )}
          </div>
          {list.models.some((m) => m.input_price_per_mtok != null) && <div className="mt-1.5 text-[11px] text-faint">Prices in USD per 1M input / output tokens, as the provider publishes them.</div>}
        </div>
      )}
      {list.error && (
        <div className="mb-3 rounded-[10px] bg-sel px-3 py-2 text-[12px] text-muted-foreground">
          Couldn't load the model list ({list.error}). Enter the model name instead.
        </div>
      )}
      {(manual || model) && (
        <div className="-ml-3 space-y-0.5">
          {manual ? (
            <FormRow label="Model name:" labelWidth={120} hint={llm ? "Exactly as the provider expects it. Pick a model that supports structured (JSON) output." : "Exactly as the provider expects it in requests."}>
              <Input
                mono
                value={model}
                onChange={setModel}
                placeholder={provider?.kind === "anthropic" ? "claude-sonnet-5-5" : llm ? (/localhost|127\.0\.0\.1/.test(provider?.base_url ?? "") ? "llama3.1:8b" : "gpt-5-mini") : "jev-latest"}
                autoFocus
              />
            </FormRow>
          ) : (
            <FormRow label="Model:" labelWidth={120}>
              <span className="font-mono text-[12.5px]">{chosen?.id ?? model}</span>
            </FormRow>
          )}
          <FormRow label="Display name:" labelWidth={120}>
            <Input value={display} onChange={setDisplay} placeholder="optional" />
          </FormRow>
          <FormRow label="Input price:" labelWidth={120} hint={chosen?.input_price_per_mtok != null ? "From the provider's list. USD per 1M tokens." : "USD per 1M tokens, used for cost monitoring."}>
            <Input mono className="max-w-[8rem]" value={inPrice} onChange={setIn} />
          </FormRow>
          <FormRow label="Output price:" labelWidth={120}>
            <Input mono className="max-w-[8rem]" value={outPrice} onChange={setOut} />
          </FormRow>
        </div>
      )}
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
  const { providers } = useApp();
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
                    <ModelIcon model={r.model} providers={providers} className="size-3 text-faint" />
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
