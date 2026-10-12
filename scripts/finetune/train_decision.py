"""Fine-tune a decision model with Unsloth (MLX on Apple silicon, PyTorch elsewhere) and export a
GGUF that llama.cpp's server answers at /v1/systemone.

The base is a Laya checkpoint (convaiinnovations/laya), a Clef checkpoint, or a plain language
model, which gets a new Clef-style head (e.g. unsloth/Qwen3.5-0.8B). Rows are Unsloth's decision
format, one JSON object per line: {"state": ..., "questions": {...}, "gold": {...}}.

    python train_decision.py --base convaiinnovations/laya --train train.jsonl --calib calib.jsonl \
        --out runs/laya-en --epochs 2

Prints one JSON line: accuracy and calibration error on the calibration rows before and after,
train time, and where the GGUF went. With --events, progress goes to stdout as lines starting with
"@@" followed by a JSON object (ClassifAI Studio reads these). Unsloth's decision code is
AGPL-3.0; this script only calls it, run as a separate process.
"""

import argparse
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

from unsloth import DecisionTrainer, FastDecisionModel  # noqa: I001  (Unsloth first)
from transformers import TrainerCallback, TrainingArguments

EVENTS = False


def emit(event, **fields):
    if EVENTS:
        sys.stdout.write("@@" + json.dumps({"event": event, **fields}) + "\n")
        sys.stdout.flush()


class Progress(TrainerCallback):
    """Steps, epochs and the training loss as events."""

    def __init__(self):
        self.t0 = time.time()

    def on_train_begin(self, args, state, control, **kwargs):
        self.t0 = time.time()
        emit("step", step=0, total=int(state.max_steps or 0), epoch=0.0, elapsed=0.0)

    def on_step_end(self, args, state, control, **kwargs):
        emit("step", step=int(state.global_step), total=int(state.max_steps or 0), epoch=float(state.epoch or 0.0), elapsed=round(time.time() - self.t0, 1))

    def on_log(self, args, state, control, logs=None, **kwargs):
        if logs and "loss" in logs:
            emit("loss", step=int(state.global_step), loss=float(logs["loss"]))


# What Unsloth reads from a repository, by checkpoint layout (as its _checkpoint_folder fetches it).
def download_patterns(layout, subfolder):
    prefix = f"{subfolder}/" if subfolder else ""
    if layout == "laya":
        return [prefix + "rl_agent_config.json", prefix + "model.safetensors", prefix + "encoder/*", prefix + "tokenizer/*"], None
    if layout == "clef":
        return [prefix + "*"], None
    # A plain language model: everything but other weight formats.
    return None, ["*.gguf", "*.pth", "*.onnx", "original/*", "*.msgpack", "*.h5"]


def predownload(repo, subfolder, layout):
    """Download the base model's files with byte progress as "download" events, so loading it
    afterwards reads from the cache. Does nothing for a local folder or when the files are cached."""
    if os.path.isdir(repo):
        return
    try:
        from huggingface_hub import snapshot_download
        from huggingface_hub.utils import tqdm as hf_tqdm
    except Exception:
        return
    allow, ignore = download_patterns(layout, subfolder)
    try:
        plan = snapshot_download(repo, allow_patterns=allow, ignore_patterns=ignore, dry_run=True)
    except Exception as e:  # offline, or a gated repo: loading reports the real error
        emit("download", error=str(e)[:300])
        return
    todo = [f for f in plan if f.will_download]
    total = sum(f.file_size or 0 for f in todo)
    cached = sum(f.file_size or 0 for f in plan if not f.will_download)
    if not todo:
        emit("download", done=0, total=0, files_done=0, files=0, cached=cached, elapsed=0.0)
        return
    started = time.time()
    state = {"done": 0, "files": 0, "last": 0.0}
    lock = threading.Lock()

    def report(force=False):
        now = time.time()
        if force or now - state["last"] > 0.4:
            state["last"] = now
            emit("download", done=min(state["done"], total), total=total, files_done=state["files"], files=len(todo), cached=cached, elapsed=round(now - started, 1))

    class Progress(hf_tqdm):
        # huggingface_hub turns bars off when stderr isn't a terminal; these only count.
        def __init__(self, *args, **kwargs):
            self._kind = kwargs.get("name") or ""
            kwargs["disable"] = False
            kwargs["file"] = open(os.devnull, "w")
            super().__init__(*args, **kwargs)

        def update(self, n=1):
            out = super().update(n)
            with lock:
                if self._kind == "huggingface_hub.snapshot_download":
                    state["done"] = int(self.n)
                elif self._kind == "" and self.unit != "B":
                    state["files"] = int(self.n)
                report()
            return out

    snapshot_download(repo, allow_patterns=allow, ignore_patterns=ignore, tqdm_class=Progress)
    state["done"], state["files"] = total, len(todo)
    report(force=True)


def read_rows(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def count_parameters(model):
    """(all, trainable) weights, for MLX and PyTorch models; None when it can't be read."""
    try:
        from mlx.utils import tree_flatten

        total = sum(v.size for _, v in tree_flatten(model.parameters()))
        trainable = sum(v.size for _, v in tree_flatten(model.trainable_parameters()))
        return int(total), int(trainable)
    except Exception:
        pass
    try:
        params = list(model.parameters())
        return sum(p.numel() for p in params), sum(p.numel() for p in params if p.requires_grad)
    except Exception:
        return None


def analyse(model, tokenizer, rows, limit=300):
    """Each calibration row's answers: [row, question, predicted, probability of it]. For the
    before/after views (per label, calibration, rows it learned)."""
    out = []
    for i, row in enumerate(rows[:limit]):
        try:
            answers = FastDecisionModel.predict(model, tokenizer, row["state"], row["questions"])
        except Exception:
            continue
        for q, a in answers.items():
            probs = a.get("probabilities") or {}
            out.append([i, q, a.get("answer"), round(float(max(probs.values())) if probs else 0.0, 4)])
    return out


def gold_of(rows, limit=300):
    """[row, question, gold, text] for the rows `analyse` reads."""
    out = []
    for i, row in enumerate(rows[:limit]):
        state = row["state"] if isinstance(row["state"], str) else json.dumps(row["state"], ensure_ascii=False)
        for q, g in row["gold"].items():
            out.append([i, q, g, state[:400]])
    return out


def scores(model, tokenizer, items):
    m = FastDecisionModel.evaluate(model, tokenizer, items)
    return {k: round(float(m[k]), 4) for k in ("accuracy", "ece") if k in m}


def main():
    global EVENTS
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", required=True, help="HF repo or folder")
    p.add_argument("--subfolder", default=None)
    p.add_argument("--layout", default=None, choices=["laya", "clef", "lm"], help="checkpoint layout, for downloading only what's needed")
    p.add_argument("--train", required=True)
    p.add_argument("--calib", required=True, help="held-out rows: before/after scores and temperature fit")
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=float, default=2.0)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--head-lr", type=float, default=None)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--grad-accum", type=int, default=1)
    p.add_argument("--max-seq-length", type=int, default=512)
    p.add_argument("--load-in-4bit", action="store_true", help="Clef / language models only")
    p.add_argument("--gguf", default="q8_0", help="q8_0, f16, bf16, or 'none'")
    p.add_argument("--keep-merged", action="store_true", help="keep the merged 16-bit checkpoint next to the GGUF")
    p.add_argument("--events", action="store_true", help="progress as @@{json} lines on stdout")
    p.add_argument("--seed", type=int, default=3407)
    a = p.parse_args()
    EVENTS = a.events
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    result = {"base": a.base, "subfolder": a.subfolder}

    emit("stage", stage="loading")
    if EVENTS and a.layout:
        predownload(a.base, a.subfolder, a.layout)
    t0 = time.time()
    model, tokenizer = FastDecisionModel.from_pretrained(
        a.base,
        subfolder=a.subfolder,
        max_seq_length=a.max_seq_length,
        load_in_4bit=a.load_in_4bit,
        random_state=a.seed,
    )
    result["load_s"] = round(time.time() - t0, 1)

    calib_rows = read_rows(a.calib)
    train, report = FastDecisionModel.build_dataset(read_rows(a.train), tokenizer, model)
    calib, _ = FastDecisionModel.build_dataset(calib_rows, tokenizer, model)
    result["train_items"], result["calib_items"] = len(train), len(calib)
    result["dataset_report"] = report

    emit("stage", stage="baseline")
    FastDecisionModel.for_inference(model)
    result["before"] = scores(model, tokenizer, calib)
    emit("scores", which="before", **result["before"])
    if EVENTS:
        emit("gold", items=gold_of(calib_rows))
        emit("analysis", which="before", items=analyse(model, tokenizer, calib_rows))

    emit("stage", stage="training")
    model = FastDecisionModel.get_peft_model(model, r=a.lora_r, lora_alpha=2 * a.lora_r, random_state=a.seed)
    FastDecisionModel.for_training(model)
    counts = count_parameters(model)
    if counts:
        emit("model", parameters=counts[0], trainable=counts[1], batch_size=a.batch_size * a.grad_accum, records=len(train))
    args = TrainingArguments(
        output_dir=str(out / "checkpoints"),
        per_device_train_batch_size=a.batch_size,
        gradient_accumulation_steps=a.grad_accum,
        num_train_epochs=a.epochs,
        learning_rate=a.lr,
        warmup_steps=0.05,  # a fraction of all steps in transformers 5
        logging_steps=5,
        save_strategy="no",
        report_to="none",
        seed=a.seed,
    )
    trainer = DecisionTrainer(
        model=model,
        args=args,
        train_dataset=train,
        tokenizer=tokenizer,
        head_learning_rate=a.head_lr,
        callbacks=[Progress()],
    )
    t0 = time.time()
    trainer.train()
    result["train_s"] = round(time.time() - t0, 1)

    emit("stage", stage="calibrating")
    FastDecisionModel.for_inference(model)
    result["after_uncalibrated"] = scores(model, tokenizer, calib)
    FastDecisionModel.calibrate(model, tokenizer, calib)
    result["after"] = scores(model, tokenizer, calib)
    result["temperature"] = model.decision_config.get("temperature")
    emit("scores", which="after", **result["after"])
    if EVENTS:
        emit("analysis", which="after", items=analyse(model, tokenizer, calib_rows))

    emit("stage", stage="exporting")
    model.save_pretrained_merged(str(out / "merged"), tokenizer)
    if a.gguf != "none":
        t0 = time.time()
        export = model.save_pretrained_gguf(str(out), tokenizer, quantization_method=a.gguf)
        result["gguf"] = export
        result["gguf_s"] = round(time.time() - t0, 1)
    if a.keep_merged or a.gguf == "none":
        result["merged"] = str(out / "merged")
    else:
        shutil.rmtree(out / "merged", ignore_errors=True)
    shutil.rmtree(out / "checkpoints", ignore_errors=True)

    (out / "result.json").write_text(json.dumps(result, indent=2, default=str))
    emit("done", result=json.loads(json.dumps(result, default=str)))
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    main()
