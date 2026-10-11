// Screenshots for the README and the website: drives the browser build (`pnpm dev`, which uses
// the in-browser demo backend) in headless Chrome and saves 2x PNGs to docs/screenshots.
//
//     pnpm dev &
//     node --experimental-websocket scripts/screenshots.mjs [only-this-shot]
//
// Needs Google Chrome. Node 22+ doesn't need the flag.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = process.env.APP_URL ?? "http://localhost:1420";
const OUT = new URL("../docs/screenshots/", import.meta.url).pathname;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1440;
const H = 900;
const PORT = 9333;
const only = process.argv[2];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

function client(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  const ready = new Promise((r) => (ws.onopen = r));
  const send = async (method, params = {}) => {
    await ready;
    const n = ++id;
    ws.send(JSON.stringify({ id: n, method, params }));
    return new Promise((resolve, reject) => pending.set(n, { resolve, reject }));
  };
  return { send, close: () => ws.close() };
}

// Helpers available in the page as `h.*`.
const HELPERS = `
window.h = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  buttons: () => [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0),
  click(text, { exact = true, last = false, within } = {}) {
    const scope = within ? document.querySelector(within) : document;
    const all = [...(scope ?? document).querySelectorAll("button, [role=tab], [role=option]")].filter((b) => b.getBoundingClientRect().width > 0);
    // Segmented controls render each label twice (one copy only sizes the button).
    const same = (t) => t === text || t === text + text;
    const hits = all.filter((b) => (exact ? same(b.textContent.trim()) : b.textContent.includes(text)));
    const b = last ? hits[hits.length - 1] : hits[0];
    if (!b) throw new Error("no button: " + text);
    b.click();
  },
  /** Type into the input whose placeholder starts with \`placeholder\` (as React expects it). */
  type(placeholder, value) {
    const el = [...document.querySelectorAll("input, textarea")].find((i) => i.placeholder.startsWith(placeholder));
    if (!el) throw new Error("no input: " + placeholder);
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  key(key, opts = {}) {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));
  },
  select(column, word) {
    const dd = [...document.querySelectorAll("[data-column]")].find((d) => d.dataset.column === column);
    const walker = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf(word);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + word.length);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        return;
      }
    }
    throw new Error("text not found: " + word);
  },
};`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "classifai-shots-"));
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--no-first-run", `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });
  const c = client(await connect());
  const run = async (js) => {
    const r = await c.send("Runtime.evaluate", { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  // `state`: UI state to start from (the app imports `classifai:*` browser storage on startup).
  const open = async (dark = false, state = {}) => {
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await c.send("Page.navigate", { url: APP });
    await sleep(1200);
    await run(`localStorage.clear(); ${Object.entries(state).map(([k, v]) => `localStorage.setItem(${JSON.stringify("classifai:" + k)}, ${JSON.stringify(JSON.stringify(v))});`).join(" ")}`);
    await c.send("Page.navigate", { url: APP });
    await sleep(2500);
    await run(HELPERS);
  };
  const COMPARE = {
    quick: {
      text: "Third time this year you've charged my invoice twice. I want a refund for both payments today or I'm cancelling. Honestly furious.",
      selected: ["@typesafe/jev-latest", "@anthropic/claude-haiku-4-5-20251001", "laya:en"],
    },
  };
  const shot = async (name) => {
    await sleep(600);
    const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    console.log("saved", name);
  };

  await c.send("Page.enable");
  await c.send("Runtime.enable");

  const shots = {
    // Decision models and an LLM side by side on the same questions.
    async playground() {
      await open(false, COMPARE);
      await run(`h.click("Playground"); await h.sleep(500); h.click("Classify", { exact: false }); await h.sleep(7000);`);
      await shot("playground");
    },
    async "playground-dark"() {
      await open(true, COMPARE);
      await run(`h.click("Playground"); await h.sleep(500); h.click("Classify", { exact: false }); await h.sleep(7000);`);
      await shot("playground-dark");
    },
    // Manual labelling with context passages.
    async labelling() {
      await open();
      await run(`h.click("Manual labelling"); await h.sleep(500); h.click("New labelling session"); await h.sleep(800);
        h.click("Write new"); await h.sleep(400);
        h.click("Start from an example"); await h.sleep(300);
        h.type("Question set name", "Ticket triage"); await h.sleep(300);
        h.click("Start labelling"); await h.sleep(1500);
        h.select("body", "charged twice"); document.dispatchEvent(new MouseEvent("mouseup")); await h.sleep(150);
        h.click("Add as context", { exact: false }); await h.sleep(300);
        h.key("1"); await h.sleep(300);
        h.select("body", "this month"); document.dispatchEvent(new MouseEvent("mouseup")); await h.sleep(150);
        h.click("Add as context", { exact: false }); await h.sleep(300);
        getSelection().removeAllRanges();`);
      await shot("labelling");
    },
    // An evaluation: leaderboard, calibration, confusion.
    async evaluation() {
      await open();
      await run(`h.click("Evaluations"); await h.sleep(700);
        const row = [...document.querySelectorAll("a, button, tr, [role=row]")].find((e) => /Routing v2/.test(e.textContent) && e.getBoundingClientRect().height < 120);
        row.click(); await h.sleep(1500);
        h.click("department"); await h.sleep(1500);`);
      await shot("evaluation");
    },
    // Providers: decision models and LLMs.
    async models() {
      await open();
      await run(`[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "Models").click(); await h.sleep(900);
        h.click("Cloud"); await h.sleep(900);
        [...document.querySelectorAll("div")].find((d) => d.textContent.trim().startsWith("Cloudflare Workers AI") && d.children.length < 4)?.scrollIntoView({ block: "start" }); await h.sleep(400);`);
      await shot("models");
    },
  };

  try {
    for (const [name, fn] of Object.entries(shots)) {
      if (only && name !== only) continue;
      try {
        await fn();
      } catch (e) {
        console.error(name, "failed:", e.message);
      }
    }
  } finally {
    c.close();
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

main();
