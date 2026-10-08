import type { Route } from "./app";

/** A backend error turned into something a person can act on. */
export interface Problem {
  message: string;
  action?: { label: string; route: Route };
}

function parts(e: unknown): { code: string; message: string } {
  if (e && typeof e === "object" && "code" in e && "message" in e) return { code: String((e as { code: unknown }).code), message: String((e as { message: unknown }).message) };
  return { code: "", message: typeof e === "string" ? e : String(e) };
}

/** Map error codes (classifai-core Error::code and provider codes) to plain language plus a fix. */
export function describeError(e: unknown): Problem {
  const { code, message } = parts(e);
  const provider = /@([a-z0-9-]+)\//.exec(message)?.[1];
  switch (code) {
    case "ENGINE_OFFLINE":
      return { message: "The local engine isn't running.", action: { label: "Open engine settings", route: { page: "settings", tab: "engine" } } };
    case "ENGINE_NOT_INSTALLED":
      return { message: "The local engine isn't installed yet.", action: { label: "Install engine", route: { page: "settings", tab: "engine" } } };
    case "MODEL_NOT_FOUND":
      return { message: "This model isn't downloaded on this Mac.", action: { label: "Open model library", route: { page: "models" } } };
    case "NO_API_KEY":
      return { message: `${provider ? `${provider[0].toUpperCase()}${provider.slice(1)}` : "This provider"} isn't connected — add an API key first.`, action: { label: "Connect provider", route: { page: "models" } } };
    case "UNAUTHORIZED":
      return { message: "The provider rejected the API key. It may be wrong, expired or missing permissions.", action: { label: "Update key", route: { page: "models" } } };
    case "RATE_LIMITED":
      return { message: "The provider's rate limit was hit. Wait a moment or lower the concurrency." };
    case "OVERLOADED":
      return { message: "The provider is overloaded right now. Try again in a minute." };
    case "PROVIDER_UNREACHABLE":
    case "HTTP":
      return { message: "Couldn't reach the provider. Check your internet connection." };
    case "BUDGET_EXCEEDED":
      return { message: "This month's cloud budget is used up, so cloud requests are paused.", action: { label: "Budget settings", route: { page: "settings", tab: "accounts" } } };
    case "KEYCHAIN":
      return { message: "macOS Keychain refused access to the API key. Allow ClassifAI in the Keychain prompt and try again." };
    case "TOO_MANY_OPTIONS":
      return { message: "Too many options for this model's context. Split the question or pick a model with a larger context." };
    case "INPUT_TOO_LONG":
    case "STATE_TRUNCATED":
      return { message: "The input is too long for this model. Shorten it or use a long-context model (e.g. von, clef)." };
    default:
      return { message: message.replace(/^network error: /, "Network error: ") };
  }
}
