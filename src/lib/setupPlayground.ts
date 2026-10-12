// Open a row of an evaluation or a fine-tune in the Playground with the questions it was asked,
// so the answers show next to the row's ground truth (and other rows are a keypress away).
import { composeInput } from "../components/OpenRowModal";
import { api } from "./api";
import { handoff } from "./handoff";
import { blank, type QDraft } from "./questionDraft";
import { newRid } from "./routing";
import type { ExperimentConfig, FineTune, LabelSpec, Row, TaskSpec } from "./types";

const BASE_OLLAYA: Record<string, string> = { "laya-en": "laya:en", "laya-multilingual": "laya:multilingual", clef: "clef" };

const describe = (l?: LabelSpec) => (l ? l.description?.trim() || l.value : "");

/** Raw ground-truth cell (trimmed) → what the Playground compares answers with: the label for a
 *  pick-one question (aliases included), yes/no for a yes/no one. */
function labelMap(t: TaskSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of t.labels) {
    const shown = t.kind === "binary" ? (l.value === t.positive_label ? "yes" : "no") : l.value;
    for (const raw of [l.value, ...(l.aliases ?? [])]) out[raw.trim()] = shown;
  }
  return out;
}

/** The evaluation questions as Playground drafts, follow-ups included; `row` fills in the ground truth. */
export function draftsFromTasks(tasks: TaskSpec[], row?: Row): QDraft[] {
  const rids = new Map(tasks.map((t) => [t.id, newRid()]));
  return tasks.map((t) => {
    const labelOf = labelMap(t);
    const raw = row?.[t.label_column]?.trim();
    const base = {
      ...blank(t.kind === "binary" ? "noul" : "choice", t.instructions),
      rid: rids.get(t.id)!,
      context: t.context ?? "",
      column: t.label_column,
      labelOf,
      expected: raw === undefined ? undefined : labelOf[raw] ?? "",
    };
    const parent = t.when ? tasks.find((p) => p.id === t.when!.parent) : undefined;
    const when = parent && t.when ? { parent: rids.get(parent.id)!, answers: [...new Set(t.when.answers.map((a) => labelMap(parent)[a] ?? a))] } : null;
    if (t.kind === "binary") {
      const pos = t.labels.find((l) => l.value === t.positive_label);
      const neg = t.labels.find((l) => l.value !== t.positive_label);
      return { ...base, yes: describe(pos), no: describe(neg), when };
    }
    return { ...base, options: t.labels.map((l) => ({ name: l.value, description: l.description?.trim() ?? "" })), when };
  });
}

/**
 * Hand a row of `datasetId` (index `row`, or a random one) to the Playground with the setup's
 * questions and context; label corrections made in reviews are applied. `models` are selected.
 */
export async function openSetupInPlayground({ config, datasetId, row, models }: { config: ExperimentConfig; datasetId: string; row?: number; models: string[] }): Promise<void> {
  handoff.selectModels(models);
  const ds = await api.dataset(datasetId).catch(() => null);
  if (!ds || ds.row_count === 0) {
    handoff.set({ text: "", asJson: false, questions: draftsFromTasks(config.tasks), context: config.context ?? "" });
    return;
  }
  const at = row ?? Math.floor(Math.random() * ds.row_count);
  const [[idx, raw] = [at, {} as Row]] = await api.datasetRowsAt(ds.id, [at]);
  const corrections = await api.corrections(ds.id).catch(() => []);
  const cells: Row = { ...raw };
  for (const c of corrections) if (c.row_idx === idx) cells[c.column] = c.value;
  handoff.set({
    text: composeInput(cells, config.input_columns),
    asJson: false,
    questions: draftsFromTasks(config.tasks, cells),
    context: config.context ?? "",
    origin: { datasetId: ds.id, datasetName: ds.name, row: idx, inputCols: config.input_columns, rowCount: ds.row_count },
  });
}

/** A fine-tune: a random held-out row (one it never trained on), next to the model it started from. */
export async function openFineTuneInPlayground(f: FineTune, installed: string[]): Promise<void> {
  const base = BASE_OLLAYA[f.base];
  const baseName = base && installed.find((m) => m === base || m === `${base}:latest`);
  const models = [f.model, ...(baseName ? [baseName] : [])];
  const config: ExperimentConfig | null = f.config ?? (f.experiment_id ? (await api.experiment(f.experiment_id).catch(() => null))?.config ?? null : null);
  if (!config) {
    handoff.selectModels(models);
    return;
  }
  await openSetupInPlayground({ config, datasetId: f.test_dataset_id ?? config.dataset_id, models });
}
