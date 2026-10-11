// What a model can answer. Decision models (local Ollaya models and hosted decision APIs) pick
// among options, say yes/no, score or estimate a number, with probabilities. LLMs (chat and
// Anthropic providers) answer the same questions through structured output — their
// probabilities are their own estimates — and also answer free text.
import type { ProviderKind } from "./types";

export const LLM_KINDS: ProviderKind[] = ["chat", "anthropic"];
export const isLlmKind = (k: ProviderKind) => LLM_KINDS.includes(k);
/** Providers that work without a key: custom endpoints and added OpenAI-compatible chat servers (e.g. a local Ollama). Built-in hosted ones need one. */
export const keyOptional = (k: ProviderKind) => k === "custom" || k === "chat";
/** Ready to use: a key is saved, or this provider doesn't need one. */
export const isConnected = (p: { kind: ProviderKind; has_key: boolean; builtin: boolean }) => p.has_key || (keyOptional(p.kind) && !p.builtin);

// Model ids of LLMs, kept up to date by the app when providers load.
let llms = new Set<string>();
export function setLlmModels(ids: string[]) {
  llms = new Set(ids);
}

/** Is this model an LLM (answers through structured output, can write free text)? */
export const isLlm = (model: string) => llms.has(model);

export function supportsFreeText(model: string): boolean {
  return isLlm(model);
}

/** How the selected models handle free-text questions. */
export function freeTextSupport(models: string[]): { state: "none" | "some" | "all"; llms: string[]; decision: string[] } {
  const llms = models.filter(supportsFreeText);
  const decision = models.filter((m) => !supportsFreeText(m));
  return { state: llms.length === 0 ? "none" : decision.length === 0 ? "all" : "some", llms, decision };
}
