import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isConnected, isLlmKind, setLlmModels } from "./models";
import { useAnimatedToastStack, type AnimatedToast } from "@/components/motion/animated-toast-stack";
import { api, errorMessage, events, isTauri } from "./api";
import { load, save } from "./persist";
import type { BudgetStatus, CloudModel, EngineStatus, LocalModel, Provider, PullEvent } from "./types";

export type ThemePref = "system" | "light" | "dark";

export type Route =
  | { page: "quick" }
  | { page: "bulk" }
  | { page: "bulk-new"; from?: string }
  | { page: "bulk-run"; id: string }
  | { page: "question-sets" }
  | { page: "labelling" }
  | { page: "label-new" }
  | { page: "label"; id: string }
  | { page: "question-set"; id?: string }
  | { page: "datasets"; hf?: boolean; import?: boolean; workbook?: string; files?: string[] }
  | { page: "dataset"; id: string }
  | { page: "new-experiment"; datasetId?: string; fromExperiment?: string; fromSet?: string }
  | { page: "experiments" }
  | { page: "experiment"; id: string }
  | { page: "models"; tab?: "local" | "cloud" | "usage" }
  | { page: "finetune" }
  | { page: "engine" }
  | { page: "settings"; tab?: "general" | "engine" | "accounts" }
  | { page: "compare"; a: string; b?: string }
  | { page: "review"; id: string; question?: string }
  /** The first-launch welcome screen, shown again on request. */
  | { page: "onboarding" }
  | { page: "about" }
  | { page: "licenses" };

type Tone = "good" | "bad" | "neutral";

interface AppCtx {
  route: Route;
  go: (r: Route) => void;
  /** Previous page (⌘[ / toolbar back). */
  back: () => void;
  canGoBack: boolean;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  dark: boolean;
  budget: BudgetStatus | null;
  refreshBudget: () => Promise<void>;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
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
  // Restore the last page; detail pages fall back to their list if the item is gone (pages handle that).
  const [route, setRoute] = useState<Route>(() => load<Route>("route", { page: "quick" }));
  const [history, setHistory] = useState<Route[]>([]);
  const [theme, setThemeState] = useState<ThemePref>(() => load<ThemePref>("theme", "system"));
  const [sysDark, setSysDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => load<boolean>("sidebar", true));
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((o) => {
      save("sidebar", !o);
      return !o;
    });
  }, []);
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

  const cloudModels = useMemo(() => {
    const ready = providers.filter(isConnected);
    setLlmModels(ready.filter((p) => isLlmKind(p.kind)).flatMap((p) => p.models.map((m) => m.id)));
    return ready.flatMap((p) => p.models.filter((m) => m.enabled));
  }, [providers],
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

  // History lives in a ref so navigation stays a plain state update (safe under StrictMode).
  const routeRef = useRef(route);
  routeRef.current = route;
  const historyRef = useRef<Route[]>([]);

  const go = useCallback((r: Route) => {
    if (JSON.stringify(routeRef.current) !== JSON.stringify(r)) {
      historyRef.current = [...historyRef.current.slice(-30), routeRef.current];
      setHistory(historyRef.current);
    }
    setRoute(r);
    document.getElementById("main-scroll")?.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    historyRef.current = h.slice(0, -1);
    setHistory(historyRef.current);
    setRoute(h[h.length - 1]);
  }, []);

  useEffect(() => void (route.page !== "onboarding" && save("route", route)), [route]);

  // Appearance: follow the system unless the user picked light or dark in Settings.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const h = (e: MediaQueryListEvent) => setSysDark(e.matches);
    media.addEventListener("change", h);
    return () => media.removeEventListener("change", h);
  }, []);
  const dark = theme === "system" ? sysDark : theme === "dark";
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  // The sidebar shows the window's native vibrancy material, which follows the window's
  // appearance: keep that in step with the app's theme, or a dark app gets a light sidebar.
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === "system" ? null : theme))
      .catch(() => {});
  }, [theme]);
  const setTheme = useCallback((t: ThemePref) => {
    setThemeState(t);
    save("theme", t);
  }, []);

  const refreshBudget = useCallback(async () => {
    try {
      setBudget(await api.budget());
    } catch {
      setBudget(null);
    }
  }, []);
  useEffect(() => {
    refreshBudget();
    const t = setInterval(refreshBudget, 60_000);
    return () => clearInterval(t);
  }, [refreshBudget]);

  const value = useMemo(
    () => ({ route, go, back, canGoBack: history.length > 0, theme, setTheme, dark, budget, refreshBudget, sidebarOpen, toggleSidebar, engine, refreshEngine, models, refreshModels, providers, refreshProviders, cloudModels, pulls, pull, toast, toasts, dismissToast }),
    [route, go, back, history.length, theme, setTheme, dark, budget, refreshBudget, sidebarOpen, toggleSidebar, engine, refreshEngine, models, refreshModels, providers, refreshProviders, cloudModels, pulls, pull, toast, toasts, dismissToast],
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
