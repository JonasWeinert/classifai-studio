import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, events } from "./api";
import type { EngineStatus, LocalModel, PullEvent } from "./types";

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

interface Toast {
  id: number;
  tone: "good" | "bad" | "neutral";
  text: string;
}

interface AppCtx {
  route: Route;
  go: (r: Route) => void;
  engine: EngineStatus | null;
  refreshEngine: () => Promise<EngineStatus | null>;
  models: LocalModel[];
  refreshModels: () => Promise<void>;
  pulls: Record<string, PullEvent>;
  pull: (model: string) => Promise<void>;
  toast: (text: string, tone?: Toast["tone"]) => void;
  toasts: Toast[];
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ page: "quick" });
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<LocalModel[]>([]);
  const [pulls, setPulls] = useState<Record<string, PullEvent>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, tone: Toast["tone"] = "neutral") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

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
    () => ({ route, go, engine, refreshEngine, models, refreshModels, pulls, pull, toast, toasts }),
    [route, go, engine, refreshEngine, models, refreshModels, pulls, pull, toast, toasts],
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
