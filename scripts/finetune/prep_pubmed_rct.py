"""PubMed 20k RCT as a decision task: which section of an RCT abstract a sentence comes from.

Writes train.jsonl and calib.jsonl in Unsloth's decision format ({state, questions, gold}) and
test.csv for ClassifAI (text, section). Train and test come from different abstracts.

    python prep_pubmed_rct.py --out data/pubmed_rct --train 2000 --calib 300 --test 500
"""

import argparse
import csv
import json
import random
from pathlib import Path

from datasets import load_dataset

INSTRUCTIONS = "Which section of a randomised controlled trial abstract is this sentence from?"
CRITERIA = {
    "background": "Context and motivation: what is known and why the study matters.",
    "objective": "The aim, hypothesis or research question of the study.",
    "methods": "Design, participants, interventions, outcomes measured or analysis.",
    "results": "Findings: numbers, effects, comparisons and statistics.",
    "conclusions": "What the authors conclude or recommend from the findings.",
}
QUESTIONS = {"section": {"type": "choice", "instructions": INSTRUCTIONS, "criteria": CRITERIA}}


def sample(split, n, rng):
    rows = [r for r in split if r["label"] in CRITERIA]
    rng.shuffle(rows)
    return rows[:n]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="data/pubmed_rct")
    p.add_argument("--train", type=int, default=2000)
    p.add_argument("--calib", type=int, default=300)
    p.add_argument("--test", type=int, default=500)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args()
    rng = random.Random(a.seed)
    d = load_dataset("armanc/pubmed-rct20k")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    for name, split, n in (("train", "train", a.train), ("calib", "validation", a.calib)):
        with open(out / f"{name}.jsonl", "w") as f:
            for r in sample(d[split], n, rng):
                row = {"state": r["text"], "questions": QUESTIONS, "gold": {"section": r["label"]}}
                f.write(json.dumps(row) + "\n")
    with open(out / "test.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["text", "section"])
        for r in sample(d["test"], a.test, rng):
            w.writerow([r["text"], r["label"]])
    (out / "questions.json").write_text(json.dumps(QUESTIONS, indent=2))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
