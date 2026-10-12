import { CommandPalette, type CommandItem } from "@/components/motion/command-palette";
import { Boxes, Cloud, Tag, Rows3, Database, FileUp, FlaskConical, Layers, Moon, Plus, Settings, SlidersHorizontal, Sun, Zap, BookOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { SAMPLE_DATASET } from "../lib/sample";
import { useImportDataset } from "../lib/useImportDataset";
import type { Dataset, Experiment, QuestionSetSummary } from "../lib/types";

/** ⌘K: jump anywhere, open recent items, run common actions. */
export function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { go, theme, setTheme, dark } = useApp();
  const imp = useImportDataset();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [sets, setSets] = useState<QuestionSetSummary[]>([]);

  useEffect(() => {
    if (!open) return;
    api.datasets().then(setDatasets).catch(() => {});
    api.experiments().then(setExperiments).catch(() => {});
    api.questionSets().then(setSets).catch(() => {});
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const nav: CommandItem[] = [
      { id: "nav-quick", label: "Playground", group: "Go to", hint: "⌘1", icon: Zap, onSelect: () => go({ page: "quick" }) },
      { id: "nav-bulk", label: "Bulk", group: "Go to", hint: "⌘2", icon: Rows3, keywords: ["batch", "many", "csv"], onSelect: () => go({ page: "bulk" }) },
      { id: "nav-sets", label: "Question sets", group: "Go to", hint: "⌘5", icon: Layers, keywords: ["templates", "questions"], onSelect: () => go({ page: "question-sets" }) },
      { id: "nav-datasets", label: "Datasets", group: "Go to", hint: "⌘6", icon: Database, onSelect: () => go({ page: "datasets" }) },
      { id: "nav-labelling", label: "Manual labelling", group: "Go to", hint: "⌘4", icon: Tag, keywords: ["annotate", "code", "human"], onSelect: () => go({ page: "labelling" }) },
      { id: "nav-experiments", label: "Evaluations", group: "Go to", hint: "⌘3", icon: FlaskConical, onSelect: () => go({ page: "experiments" }) },
      { id: "nav-models", label: "Models", group: "Go to", hint: "⌘7", icon: Boxes, onSelect: () => go({ page: "models" }) },
      { id: "nav-cloud", label: "Cloud providers & API keys", group: "Go to", icon: Cloud, keywords: ["openai", "typesafe", "jev", "cloudflare", "key"], onSelect: () => go({ page: "models", tab: "cloud" }) },
      { id: "nav-usage", label: "Usage & cost", group: "Go to", icon: Cloud, keywords: ["spend", "budget", "billing"], onSelect: () => go({ page: "models", tab: "usage" }) },
      { id: "nav-finetune", label: "Fine-tune", group: "Go to", icon: SlidersHorizontal, onSelect: () => go({ page: "finetune" }) },
      { id: "nav-docs", label: "Guide: how fine-tuning works", group: "Go to", icon: BookOpen, keywords: ["docs", "help", "glossary", "lora", "calibration"], onSelect: () => go({ page: "docs" }) },
      { id: "new-finetune", label: "New fine-tune", group: "Actions", icon: SlidersHorizontal, onSelect: () => go({ page: "finetune-new" }) },
      ...(import.meta.env.DEV ? [{ id: "nav-onboarding", label: "Show welcome screen (dev)", group: "Go to", icon: Settings, keywords: ["onboarding", "setup", "first launch"], onSelect: () => go({ page: "onboarding" }) }] : []),
      { id: "nav-about", label: "About ClassifAI Studio", group: "Go to", icon: Settings, keywords: ["version", "copyright", "github"], onSelect: () => go({ page: "about" }) },
      { id: "nav-licenses", label: "Open source licenses", group: "Go to", icon: Settings, keywords: ["license", "credits", "attribution"], onSelect: () => go({ page: "licenses" }) },
      { id: "nav-settings", label: "Settings", group: "Go to", hint: "⌘,", icon: Settings, onSelect: () => go({ page: "settings" }) },
    ];
    const actions: CommandItem[] = [
      { id: "new-label", label: "New labelling session", group: "Actions", icon: Tag, onSelect: () => go({ page: "label-new" }) },
      { id: "import-hf", label: "Import from Hugging Face…", group: "Actions", icon: FileUp, keywords: ["huggingface", "hub"], onSelect: () => go({ page: "datasets", hf: true }) },
      { id: "new-bulk", label: "New bulk run", group: "Actions", icon: Rows3, keywords: ["batch"], onSelect: () => go({ page: "bulk-new" }) },
      { id: "new-set", label: "New question set", group: "Actions", icon: Layers, onSelect: () => go({ page: "question-set" }) },
      { id: "new-exp", label: "New evaluation", group: "Actions", hint: "⌘N", icon: Plus, onSelect: () => go({ page: "new-experiment" }) },
      { id: "import", label: "Import dataset…", group: "Actions", hint: "⌘O", icon: FileUp, onSelect: () => imp.run() },
      { id: "sample", label: "Import sample dataset (bank transactions)", group: "Actions", icon: Database, keywords: ["example", "demo", "try"], onSelect: () => imp.importText(SAMPLE_DATASET.name, SAMPLE_DATASET.text) },
      {
        id: "theme",
        label: dark ? "Switch to light appearance" : "Switch to dark appearance",
        group: "Actions",
        icon: dark ? Sun : Moon,
        keywords: ["theme", "appearance", "dark", "light"],
        onSelect: () => setTheme(theme === "system" ? (dark ? "light" : "dark") : dark ? "light" : "dark"),
      },
    ];
    return [
      ...actions,
      ...nav,
      ...experiments.slice(0, 12).map((e) => ({ id: `exp-${e.id}`, label: e.name, group: "Evaluations", hint: e.dataset_name, icon: FlaskConical, onSelect: () => go({ page: "experiment", id: e.id }) })),
      ...datasets.slice(0, 12).map((d) => ({ id: `ds-${d.id}`, label: d.name, group: "Datasets", hint: `${d.row_count.toLocaleString()} rows`, icon: Database, onSelect: () => go({ page: "dataset", id: d.id }) })),
      ...sets.map((q) => ({ id: `qs-${q.id}`, label: `Evaluation from “${q.name}”`, group: "Question sets", hint: `v${q.version}`, icon: Layers, onSelect: () => go({ page: "new-experiment", fromSet: q.id }) })),
    ];
  }, [dark, datasets, experiments, go, imp, setTheme, sets, theme]);

  return <CommandPalette items={items} open={open} onOpenChange={onOpenChange} placeholder="Search pages, evaluations, datasets…" />;
}
