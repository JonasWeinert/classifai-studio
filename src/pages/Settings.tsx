import { Cloud, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, FormRow, Input, Kbd, PageHeader, Progress, Section, Segmented, Switch } from "../components/ui";
import { api } from "../lib/api";
import { useApp, useAsync, type ThemePref } from "../lib/app";
import { usd } from "../lib/format";
import { EnginePanel } from "./EnginePanel";

type Tab = "general" | "engine" | "accounts";

const SHORTCUTS: [string, string][] = [
  ["Command palette", "⌘ K"],
  ["Quick Check · Datasets · Experiments · Models", "⌘ 1–4"],
  ["Back", "⌘ ["],
  ["New experiment", "⌘ N"],
  ["Import dataset", "⌘ O"],
  ["Classify (Quick Check)", "⌘ ↩"],
  ["Settings", "⌘ ,"],
];

export function Settings() {
  const { route, go } = useApp();
  const tab: Tab = route.page === "settings" && route.tab ? route.tab : route.page === "engine" ? "engine" : "general";
  return (
    <>
      <PageHeader
        title="Settings"
        actions={
          <Segmented
            value={tab}
            onChange={(t) => go({ page: "settings", tab: t })}
            options={[
              { value: "general", label: "General" },
              { value: "engine", label: "Engine" },
              { value: "accounts", label: "Accounts & budget" },
            ]}
          />
        }
      />
      <div key={tab} className="page-in max-w-[760px]">
        {tab === "general" && <General />}
        {tab === "engine" && <EnginePanel />}
        {tab === "accounts" && <Accounts />}
      </div>
    </>
  );
}

function General() {
  const { theme, setTheme } = useApp();
  const info = useAsync(() => api.appInfo(), []);
  return (
    <>
      <Section title="Appearance">
        <FormRow label="Appearance:">
          <Segmented<ThemePref>
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </FormRow>
      </Section>
      <Section title="Data">
        <FormRow label="Data folder:" hint="Datasets, experiments and the local engine live here. The CLI uses the same folder.">
          <span className="font-mono text-[12px]" data-selectable>
            {info.data?.data_dir ?? "…"}
          </span>
        </FormRow>
        <FormRow label="Version:">
          <span className="text-[13px]">ClassifAI {info.data?.version ?? ""}</span>
        </FormRow>
      </Section>
      <Section title="Keyboard shortcuts">
        <div className="divide-y divide-border border-y border-border">
          {SHORTCUTS.map(([what, keys]) => (
            <div key={what} className="flex items-center justify-between py-2 text-[13px]">
              <span>{what}</span>
              <span className="flex gap-1">
                {keys.split(" ").map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function Accounts() {
  const { providers, budget, refreshBudget, go, toast } = useApp();
  const settings = useAsync(() => api.settings(), []);
  const [budgetText, setBudgetText] = useState("");
  const [hardStop, setHardStop] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setBudgetText(settings.data.monthly_budget_usd === null ? "" : String(settings.data.monthly_budget_usd));
    setHardStop(settings.data.budget_hard_stop);
  }, [settings.data]);

  const saveSettings = async (patch: { budget?: string; hardStop?: boolean }) => {
    const raw = (patch.budget ?? budgetText).trim();
    const value = raw === "" ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) return toast("Enter a budget in US dollars, e.g. 20", "bad");
    await api.settingsSave({ monthly_budget_usd: value, budget_hard_stop: patch.hardStop ?? hardStop });
    await refreshBudget();
    toast("Budget saved", "good");
  };

  return (
    <>
      <Section title="Monthly cloud budget" subtitle="Estimated from your per-token prices. Local models never count.">
        <FormRow label="Budget:" hint="Leave empty for no budget. You'll see a warning at 80%.">
          <div className="flex max-w-xs items-center gap-1.5">
            <span className="text-[13px] text-muted-foreground">$</span>
            <Input value={budgetText} onChange={setBudgetText} placeholder="e.g. 20" />
            <Button onClick={() => saveSettings({})}>Save</Button>
          </div>
        </FormRow>
        <FormRow label="When used up:">
          <Switch
            checked={hardStop}
            onChange={(v) => {
              setHardStop(v);
              saveSettings({ hardStop: v });
            }}
            label="Pause cloud requests until next month"
          />
        </FormRow>
        {budget && (
          <FormRow label="This month:">
            <div className="max-w-sm">
              <div className="mb-1 flex justify-between text-[12.5px]">
                <span className="font-medium tnum">{usd(budget.month_spend_usd)}</span>
                <span className="text-muted-foreground">{budget.budget_usd !== null ? `of ${usd(budget.budget_usd)}` : "no budget set"}</span>
              </div>
              {budget.ratio !== null && <Progress value={budget.ratio} color={budget.ratio >= 1 ? "var(--bad)" : budget.ratio >= 0.8 ? "var(--warn)" : undefined} />}
            </div>
          </FormRow>
        )}
      </Section>
      <Section
        title="Cloud accounts"
        subtitle="API keys are stored in your macOS Keychain."
        actions={
          <Button size="sm" icon={<ExternalLink className="size-3" />} onClick={() => go({ page: "models", tab: "cloud" })}>
            Manage providers
          </Button>
        }
      >
        <div className="divide-y divide-border border-y border-border">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-2.5 text-[13px]">
              <Cloud className="size-3.5 text-faint" />
              <span className="flex-1">{p.name}</span>
              {p.has_key || p.kind === "custom" ? <Badge tone="good">Connected{p.key_hint ? ` · ${p.key_hint}` : ""}</Badge> : <Badge>Not connected</Badge>}
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
