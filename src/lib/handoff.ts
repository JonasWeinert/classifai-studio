// One-shot hand-off of an input to Playground ("Open in Playground" from a dataset row or prediction).
type Input = { text: string; asJson: boolean };
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
