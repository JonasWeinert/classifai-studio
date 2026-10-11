// Which local models are in memory, and which are being loaded right now. A local model's first
// request after a while loads it (seconds to a minute for big ones); the UI says so instead of
// looking stuck. Cloud models are always ready.
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import type { LocalModel } from "./types";

export type ModelState = "ready" | "loading" | "cold";

let loaded = new Set<string>();
/** model -> requests in flight and when the first started */
const inflight = new Map<string, { count: number; since: number }>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setInterval> | null = null;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};
const norm = (m: string) => m.replace(/:latest$/, "");
const isCloud = (m: string) => m.startsWith("@");

/** In memory? Routers (e.g. `laya`) count when a model of their family is loaded. */
export function isLoaded(model: string) {
  const m = norm(model);
  if (loaded.has(m)) return true;
  return !m.includes(":") && [...loaded].some((l) => l.startsWith(`${m}:`));
}

export async function refreshLoaded() {
  try {
    const names = await api.modelsLoaded();
    const next = new Set(names.map(norm));
    if (next.size !== loaded.size || [...next].some((n) => !loaded.has(n))) {
      loaded = next;
      notify();
    }
  } catch {
    /* engine down: keep what we knew */
  }
}

// Poll quickly while local requests are in flight, so "loading" flips to "ready" promptly.
function ensurePolling() {
  if (timer || ![...inflight.keys()].some((m) => !isCloud(m))) return;
  timer = setInterval(() => {
    if (![...inflight.keys()].some((m) => !isCloud(m))) {
      clearInterval(timer!);
      timer = null;
    }
    refreshLoaded();
  }, 1200);
}

/** Track a request to `model` (wraps the promise). */
export function track<T>(model: string, p: Promise<T>): Promise<T> {
  const cur = inflight.get(model);
  inflight.set(model, { count: (cur?.count ?? 0) + 1, since: cur?.since ?? Date.now() });
  notify();
  ensurePolling();
  return p.finally(() => {
    const c = inflight.get(model);
    if (c && c.count > 1) inflight.set(model, { ...c, count: c.count - 1 });
    else inflight.delete(model);
    if (!isCloud(model)) {
      // Answered, so it is in memory now (the engine may not list a router itself).
      loaded.add(norm(model));
      refreshLoaded();
    }
    notify();
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** State of one model, re-rendering as it changes. `busy` marks work the app didn't send through `track` (e.g. an evaluation run). */
export function useModelState(model: string | null | undefined, busy = false): { state: ModelState; since: number | null } {
  useSyncExternalStore(subscribe, () => version);
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    if (!model || isCloud(model)) return;
    refreshLoaded();
    if (!busy) return setBusySince(null);
    setBusySince(Date.now());
    const t = setInterval(refreshLoaded, 1200);
    return () => clearInterval(t);
  }, [model, busy]);
  if (!model || isCloud(model)) return { state: "ready", since: null };
  if (isLoaded(model)) return { state: "ready", since: null };
  const f = inflight.get(model);
  if (f) return { state: "loading", since: f.since };
  if (busy) return { state: "loading", since: busySince };
  return { state: "cold", since: null };
}

/** Seconds since `since`, ticking. */
export function useElapsed(since: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((Date.now() - since) / 1000));
}

/**
 * Order in which to run several models so results arrive soonest: cloud first (no load, usually
 * fast), then local models in memory, then the rest smallest first. Routers and unknown sizes go
 * last (a router's own size says nothing about what it loads). Same rule as experiment runs.
 */
export async function fastestOrder(models: string[], installed: LocalModel[]): Promise<string[]> {
  await refreshLoaded();
  const size = (m: string) => {
    const i = installed.find((x) => norm(x.name) === norm(m));
    return i && i.size > 0 && i.details.format !== "router" ? i.size : Infinity;
  };
  const rank = (m: string) => (isCloud(m) ? 0 : isLoaded(m) ? 1 : 2);
  return models
    .map((m, i) => ({ m, i, r: rank(m), s: isCloud(m) ? 0 : size(m) }))
    .sort((a, b) => a.r - b.r || a.s - b.s || a.i - b.i)
    .map((x) => x.m);
}
