import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAnimatedToastStack, type AnimatedToast } from "@/components/motion/animated-toast-stack";
import { api, errorMessage, events } from "./api";
import type { CloudModel, EngineStatus, LocalModel, Provider, PullEvent } from "./types";

export type Route =
  | { page: "quick" }
  | { page: "datasets" }
  | { page: "dataset"; id: string }
  | { page: "new-experiment"; datasetId?: string }
  | { page: "experiments" }
  | { page: "experiment"; id: string }
  | { page: "models" }
  | { page: "finetune" }
  | { page: "engine" };

type Tone = "good" | "bad" | "neutral";

interface AppCtx {
  route: Route;
  go: (r: Route) => void;
  engine: EngineStatus | null;
  refreshEngine: () => Promise<EngineStatus | null>;
  models: LocalModel[];
  refreshModels: () => Promise<void>;
  providers: Provider[];
  refreshProviders: () => Promise<void>;
  /** Enabled cloud models whose provider is configured. */
  cloudModels: CloudModel[];
  pulls: Record<string, PullEvent>;
  pull: (model: string) => Promise<void>;
  toast: (text: string, tone?: Tone) => void;
  toasts: AnimatedToast[];
  dismissToast: (id: string) => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ page: "quick" });
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [pulls, setPulls] = useState<Record<string, PullEvent>>({});
  const { toasts, showToast, dismissToast } = useAnimatedToastStack({ limit: 3, defaultDuration: 3600 });

  const toast = useCallback(
    (text: string, tone: Tone = "neutral") => {
      showToast({ title: text, status: tone === "good" ? "success" : tone === "bad" ? "error" : "neutral" });
    },
    [showToast],
  );

  const refreshEngine = useCallback(async () => {
    try {
      const s = await api.engineStatus();
      setEngine(s);
      return s;
    } catch {
      return null;
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      setModels(await api.modelsInstalled());
    } catch {
      setModels([]);
    }
  }, []);

  useEffect(() => {
    refreshEngine().then((s) => {
      if (s?.running) refreshModels();
    });
    const t = setInterval(refreshEngine, 8000);
    return () => clearInterval(t);
  }, [refreshEngine, refreshModels]);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await api.providers());
    } catch {
      setProviders([]);
    }
  }, []);

  useEffect(() => {
    refreshProviders();
  }, [refreshProviders]);

  const cloudModels = useMemo(
    () => providers.filter((p) => p.has_key || p.kind === "custom").flatMap((p) => p.models.filter((m) => m.enabled)),
    [providers],
  );

  useEffect(() => {
    if (engine?.running) refreshModels();
  }, [engine?.running, refreshModels]);

  useEffect(() => {
    const un = events.pull((e) => setPulls((p) => ({ ...p, [e.model]: e })));
    return () => void un.then((f) => f());
  }, []);

  const pull = useCallback(
    async (model: string) => {
      setPulls((p) => ({ ...p, [model]: { model, status: "starting", completed: 0, total: 0, done: false, error: null } }));
      try {
        await api.modelPull(model);
        toast(`${model} is ready`, "good");
      } catch (e) {
        toast(`Could not download ${model}: ${errorMessage(e)}`, "bad");
      } finally {
        setPulls((p) => {
          const { [model]: _, ...rest } = p;
          return rest;
        });
        refreshModels();
      }
    },
    [refreshModels, toast],
  );

  const go = useCallback((r: Route) => {
    setRoute(r);
    document.getElementById("main-scroll")?.scrollTo({ top: 0 });
  }, []);

  const value = useMemo(
    () => ({ route, go, engine, refreshEngine, models, refreshModels, providers, refreshProviders, cloudModels, pulls, pull, toast, toasts, dismissToast }),
    [route, go, engine, refreshEngine, models, refreshModels, providers, refreshProviders, cloudModels, pulls, pull, toast, toasts, dismissToast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

/** Load async data with loading/error state and a reload function. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fn());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}
