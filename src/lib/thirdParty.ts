// Software and model weights ClassifAI Studio downloads on the user's request, but does not ship:
// the Ollaya engine, the fine-tuning trainer and the base models. Shown on the licences page and
// where they are installed. Versions match what the app installs (engine.rs, finetune.rs).

export interface ThirdParty {
  name: string;
  version?: string;
  license: string;
  url: string;
  /** What it does in ClassifAI. */
  role: string;
  note?: string;
}

export const ENGINE: ThirdParty[] = [{ name: "Ollaya", license: "Apache-2.0", url: "https://github.com/ollaya-dev/ollaya", role: "Runs the local decision models (installed from the welcome screen)." }];

export const TRAINER: ThirdParty[] = [
  {
    name: "Unsloth",
    version: "3a1b694",
    license: "AGPL-3.0 (decision models) · Apache-2.0 (core)",
    url: "https://github.com/unslothai/unsloth",
    role: "Trains decision models.",
    note: "Its decision-model code is AGPL-3.0. ClassifAI doesn't include or modify it: it is downloaded from its repository and run as a separate program.",
  },
  { name: "unsloth-zoo", version: "f787f63", license: "LGPL-3.0", url: "https://github.com/unslothai/unsloth-zoo", role: "Training loop and models on Apple's MLX." },
  { name: "MLX", version: "0.32.3", license: "MIT", url: "https://github.com/ml-explore/mlx", role: "Runs training on the Mac's GPU." },
  { name: "PyTorch", version: "2.14.1", license: "BSD-3-Clause", url: "https://github.com/pytorch/pytorch", role: "Tensor library used by the trainer." },
  { name: "Transformers", version: "5.17.0", license: "Apache-2.0", url: "https://github.com/huggingface/transformers", role: "Tokenizers and model configurations." },
  { name: "PEFT, Accelerate, Datasets", license: "Apache-2.0", url: "https://github.com/huggingface/peft", role: "LoRA adapters and training utilities." },
  { name: "llama.cpp", version: "b11559", license: "MIT", url: "https://github.com/ggml-org/llama.cpp", role: "Converts fine-tunes to GGUF and serves them." },
  { name: "uv", version: "0.11.2", license: "MIT or Apache-2.0", url: "https://github.com/astral-sh/uv", role: "Installs Python and the packages above." },
  { name: "Python", version: "3.12", license: "PSF-2.0", url: "https://www.python.org", role: "Runs the trainer." },
];

/** Base models a fine-tune can start from; a fine-tune's weights carry the base's licence. */
export const BASE_MODELS: ThirdParty[] = [
  { name: "Laya (English and multilingual)", license: "Apache-2.0", url: "https://huggingface.co/convaiinnovations/laya", role: "Base for Laya fine-tunes." },
  { name: "Clef Flash", license: "Apache-2.0", url: "https://huggingface.co/Cloudflare/clef-flash", role: "Base for Clef fine-tunes." },
  { name: "Qwen3.5 0.8B and 2B", license: "Apache-2.0", url: "https://huggingface.co/Qwen", role: "Base for fine-tunes with a new decision head." },
];
