# ClassifAI

Classify data with local **decision models** and compare them on your own ground truth.
Built with Tauri 2 (Rust + React), powered by [Ollaya](https://github.com/ollaya-dev/ollaya).

- **Playground:** paste one entry, define labels (or yes/no, a scale, a preset) and compare models side by side.
- **Datasets:** import CSV / TSV / JSON / JSONL and choose the input and ground-truth columns.
- **Experiments:** run rows × models with live progress; get a leaderboard (accuracy, macro F1, ECE,
  latency), confusion matrices, calibration, model agreement and an error explorer; export to CSV.
- **Models:** install Ollaya on first launch, then pull and remove models from a curated library.
- **Fine-tune:** design mockup (planned: calibration → head training → LoRA).
- **CLI preview:** `classifai check "text" -m laya -l billing,technical,account`.

See [docs/PRODUCT_PLAN.md](docs/PRODUCT_PLAN.md) and [docs/PRD.md](docs/PRD.md).

## Layout

```
crates/classifai-core   Rust core: Ollaya client, engine manager, dataset parsing, SQLite store,
                        experiment runner, metrics (shared by app and CLI)
crates/classifai-cli    `classifai` command line (preview)
src-tauri               Tauri shell: commands + events over classifai-core
src                     React UI (Tailwind v4); src/lib/mock.ts = in-browser mock backend
scripts/fake_ollaya.py  Ollaya stand-in for tests and offline development
docs                    Product plan and PRD
```

## Develop

Prerequisites: Rust (stable), Node 20+, pnpm.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

On first launch the app offers to install Ollaya into its own data folder
(`~/Library/Application Support/dev.classifai.app/engine`, no sudo) and to download `laya`.
An existing `ollaya` on your PATH, or a daemon already running on `127.0.0.1:11435`, is used instead.

UI-only work without Rust: `pnpm dev`, then open http://localhost:1420. It uses a mock backend;
add `?fresh` to the URL to see onboarding.

### Tests

```bash
cargo test --workspace
```

End-to-end runner test against the fake engine (or a real Ollaya on :11435):

```bash
python3 scripts/fake_ollaya.py 11999 & CLASSIFAI_TEST_OLLAYA=http://127.0.0.1:11999 cargo test -p classifai-core -- --ignored
```

### CLI

```bash
cargo run -p classifai-cli -- check "Refund my double charge" -m laya -l billing,technical,account
```

The CLI uses the same database as the app, so `classifai experiments` and `classifai report <id>` show what you ran in the GUI.

### Build

```bash
pnpm tauri build
```
