// One-shot hand-off of an input to Playground ("Open in Playground" from a dataset row or prediction).
import type { QDraft } from "./questionDraft";

/** Where a hand-off came from, so the Playground can show the row's own values next to the answers. */
export interface Origin {
  datasetId: string;
  datasetName: string;
  row: number;
  /** Columns that make up the input, so the Playground can move to another row of the dataset. */
  inputCols?: string[];
  rowCount?: number;
}

type Input = { text: string; asJson: boolean; questions?: QDraft[]; origin?: Origin };
let pending: Input | null = null;

export const handoff = {
  set(input: Input) {
    pending = input;
  },
  take(): Input | null {
    const p = pending;
    pending = null;
    return p;
  },
};
