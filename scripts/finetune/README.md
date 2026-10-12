# Fine-tuning decision models

The app does all of this from the Fine-tune page (`crates/classifai-core/src/finetune.rs`): it
installs the trainer into `<app data>/trainer`, runs `train_decision.py` with `--events`, and
serves the results with one llama-server in router mode. This folder is for running the steps by
hand. `cargo run -p classifai-core --example finetune_e2e` runs the app's code path end to end
(install, train, held-out test) in its own data folder.

Train a decision model on labelled rows with [Unsloth](https://github.com/unslothai/unsloth),
export it to GGUF, serve it with llama.cpp's `llama-server` at `/v1/systemone`, and evaluate it
in ClassifAI against the stock model in Ollaya. On Apple silicon Unsloth trains through MLX.

```
labelled rows ──► train_decision.py (Unsloth, Python) ──► model-Q8_0.gguf
                                                              │
ClassifAI ──► custom provider (TypeSafe /v1/systemone) ──► llama-server
          └─► Ollaya (stock laya, clef …)
```

Python is needed only for training. Serving is llama.cpp (MIT), which ClassifAI already talks to
as a custom TypeSafe endpoint.

## Licences

- Unsloth core: Apache-2.0. **Its decision-model code (`unsloth/models/decision*.py`) is
  AGPL-3.0-only**, and unsloth-zoo (the MLX trainer) is LGPL-3.0. These scripts only call it, in a
  separate Python process that the user installs. Don't vendor or modify Unsloth's code.
- llama.cpp: MIT. Laya (`convaiinnovations/laya`) and Qwen3.5: Apache-2.0.

## Setup

Unsloth's MLX decision training was merged on 2026-10-08, after the last PyPI release
(2026.10.3), so install from git. llama.cpp must be b11443 or newer for decision GGUFs and
`/v1/systemone`; Homebrew's 0.5.0 (b11146) is too old.

```bash
uv venv -p 3.12 .venv
uv pip install -p .venv/bin/python "unsloth @ git+https://github.com/unslothai/unsloth" \
    "unsloth-zoo @ git+https://github.com/unslothai/unsloth-zoo" mlx torch accelerate peft gguf datasets
# GGUF converter sources and the server, same llama.cpp release
git clone --depth 1 --branch b11559 https://github.com/ggml-org/llama.cpp llama.cpp-src
gh release download b11559 -R ggml-org/llama.cpp -p 'llama-b11559-bin-macos-arm64.tar.gz'
export UNSLOTH_LLAMA_CPP_SCRIPTS_DIR=$PWD/llama.cpp-src
```

## Run

```bash
python prep_pubmed_rct.py --out data/pubmed_rct          # or your own rows
python train_decision.py --base convaiinnovations/laya --train data/pubmed_rct/train.jsonl \
    --calib data/pubmed_rct/calib.jsonl --out runs/laya-en --epochs 2
llama-server -m runs/laya-en/gguf/model-Q8_0.gguf --port 9931 --alias laya-pubmed
cargo run -p classifai-core --example decision_eval -- \
    --csv data/pubmed_rct/test.csv --questions data/pubmed_rct/questions.json \
    --label-column section --model laya:en \
    --endpoint "Laya PubMed=http://127.0.0.1:9931#laya-pubmed"
```

`--base` takes a Laya or Clef checkpoint, or a plain language model (e.g.
`unsloth/Qwen3.5-0.8B`), which gets a new Clef-style head. Only ModernBERT Laya models and
Qwen3.5-based Clef models export to GGUF; others serve through PyTorch only.

`decision_eval` writes the dataset, a custom provider and the experiment into the app's database
(`--db memory` to avoid that), so the results open in the app like any other evaluation.
