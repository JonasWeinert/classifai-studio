// The guide: what ClassifAI's models are and how fine-tuning works, from the idea to reading the
// results, with the terms explained. Plain language first; the mechanism for those who want it.
import { BookOpen, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, PageHeader, SearchField } from "../components/ui";
import { useApp } from "../lib/app";
import { cn } from "../lib/utils";

const TOC: { id: string; title: string; group: string }[] = [
  { id: "models", title: "Decision models and LLMs", group: "Basics" },
  { id: "evaluations", title: "Evaluations and ground truth", group: "Basics" },
  { id: "finetuning", title: "What fine-tuning is", group: "Fine-tuning" },
  { id: "when", title: "When it's worth it", group: "Fine-tuning" },
  { id: "pipeline", title: "What happens when you start", group: "Fine-tuning" },
  { id: "split", title: "Train, calibrate, test", group: "Fine-tuning" },
  { id: "bases", title: "Choosing a base model", group: "Fine-tuning" },
  { id: "training", title: "How training works", group: "Fine-tuning" },
  { id: "lora", title: "LoRA and the decision head", group: "Fine-tuning" },
  { id: "calibration", title: "Calibration", group: "Fine-tuning" },
  { id: "results", title: "Reading the results", group: "Fine-tuning" },
  { id: "tips", title: "Getting better results", group: "Fine-tuning" },
  { id: "under-the-hood", title: "Under the hood", group: "Fine-tuning" },
  { id: "glossary", title: "Glossary", group: "Reference" },
];

export function Docs({ topic }: { topic?: string }) {
  const { go } = useApp();
  const [active, setActive] = useState(topic ?? TOC[0].id);
  const container = useRef<HTMLDivElement>(null);

  // Jump to the requested topic, then follow the reader.
  useEffect(() => {
    if (topic) document.getElementById(`doc-${topic}`)?.scrollIntoView({ block: "start" });
  }, [topic]);
  useEffect(() => {
    const els = TOC.map((t) => document.getElementById(`doc-${t.id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.replace(/^doc-/, ""));
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  const groups = [...new Set(TOC.map((t) => t.group))];
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <BookOpen className="size-4 text-primary" /> Guide
          </span>
        }
        subtitle="How ClassifAI's models work, and how to fine-tune one on your own labels."
        actions={
          <Button variant="primary" onClick={() => go({ page: "finetune-new" })}>
            New fine-tune
          </Button>
        }
      />
      <div ref={container} className="grid grid-cols-[13rem_minmax(0,1fr)] gap-12">
        <nav className="sticky top-4 self-start text-[12.5px]">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-faint">{g}</div>
              {TOC.filter((t) => t.group === g).map((t) => (
                <button
                  key={t.id}
                  onClick={() => document.getElementById(`doc-${t.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className={cn(
                    "block w-full rounded-[6px] border-l-2 py-1 pl-2.5 text-left transition-colors",
                    active === t.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.title}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <article className="max-w-[46rem] pb-24 text-[13.5px] leading-[1.7] text-foreground/90">
          <Content />
        </article>
      </div>
    </>
  );
}

// ---- building blocks ------------------------------------------------------------------------

function H2({ id, children, kicker }: { id: string; children: ReactNode; kicker?: string }) {
  return (
    <h2 id={`doc-${id}`} className="scroll-mt-6 border-t border-border pt-8 pb-1 text-[19px] font-semibold tracking-[-0.015em] text-foreground first:border-t-0 first:pt-0">
      {kicker && <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-primary">{kicker}</div>}
      {children}
    </h2>
  );
}
const H3 = ({ children }: { children: ReactNode }) => <h3 className="mt-6 mb-1 text-[14.5px] font-semibold text-foreground">{children}</h3>;
const P = ({ children }: { children: ReactNode }) => <p className="my-3">{children}</p>;
const B = ({ children }: { children: ReactNode }) => <b className="font-semibold text-foreground">{children}</b>;
const T = ({ children }: { children: ReactNode }) => <span className="rounded-[4px] bg-sel px-1 py-px font-mono text-[12px]">{children}</span>;

function Callout({ tone = "info", title, children }: { tone?: "info" | "tip" | "warn"; title: string; children: ReactNode }) {
  const c = { info: "border-primary/40 bg-primary/[0.05]", tip: "border-good/50 bg-good-soft", warn: "border-warn/50 bg-warn-soft" }[tone];
  return (
    <div className={cn("my-5 rounded-[12px] border-l-[3px] px-4 py-3 text-[13px]", c)}>
      <div className="font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-muted-foreground [&_p]:my-1.5">{children}</div>
    </div>
  );
}

function Figure({ children, caption }: { children: ReactNode; caption: ReactNode }) {
  return (
    <figure className="my-6">
      <div className="rounded-[14px] bg-card px-5 py-5">{children}</div>
      <figcaption className="mt-2 text-[12px] text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="my-5 overflow-hidden rounded-[12px] border border-border">
      <table className="w-full text-[12.5px]">
        <thead className="bg-card text-[11.5px] text-faint">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 text-left font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border align-top">
              {r.map((c, j) => (
                <td key={j} className={cn("px-3 py-2", j === 0 && "font-medium text-foreground")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- figures --------------------------------------------------------------------------------

function PipelineFigure() {
  const steps = [
    ["Split", "hold out test rows"],
    ["Compare", "other models answer them"],
    ["Train", "learn from the rest"],
    ["Calibrate", "tune its confidence"],
    ["Save", "8-bit GGUF file"],
    ["Test", "same rows, side by side"],
  ];
  return (
    <div className="flex items-start">
      {steps.map(([t, s], i) => (
        <div key={t} className="flex flex-1 items-start">
          <div className="flex flex-1 flex-col items-center text-center">
            <div className="grid size-9 place-items-center rounded-full bg-primary text-[12px] font-semibold text-white">{i + 1}</div>
            <div className="mt-1.5 text-[12px] font-semibold">{t}</div>
            <div className="text-[11px] leading-tight text-muted-foreground">{s}</div>
          </div>
          {i < steps.length - 1 && <div className="mt-[18px] h-[2px] w-4 shrink-0 bg-primary/40" />}
        </div>
      ))}
    </div>
  );
}

function SplitFigure() {
  const parts = [
    { label: "Train", share: 0.72, color: "var(--primary)", text: "The model learns from these." },
    { label: "Calibrate", share: 0.08, color: "#06b6d4", text: "Tunes its confidence; not trained on." },
    { label: "Test", share: 0.2, color: "#f59e0b", text: "Locked away until the very end." },
  ];
  return (
    <div>
      <div className="flex h-9 overflow-hidden rounded-[8px] text-[11.5px] font-semibold text-white">
        {parts.map((p) => (
          <div key={p.label} className="grid place-items-center" style={{ width: `${p.share * 100}%`, background: p.color }}>
            {p.share > 0.1 ? `${p.label} · ${Math.round(p.share * 100)}%` : ""}
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-4 text-[12px]">
        {parts.map((p) => (
          <div key={p.label}>
            <div className="flex items-center gap-1.5 font-semibold">
              <span className="size-2.5 rounded-[3px]" style={{ background: p.color }} />
              {p.label}
            </div>
            <div className="text-muted-foreground">{p.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A big frozen weight matrix, plus two thin trainable matrices (A, B) whose product is added to it. */
function LoraFigure() {
  return (
    <svg viewBox="0 0 560 170" className="w-full" role="img" aria-label="LoRA: a frozen weight matrix plus a small trainable update">
      <defs>
        <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
          <rect width="10" height="10" fill="var(--sel)" />
          <path d="M10 0H0V10" fill="none" stroke="var(--background)" strokeWidth="1.2" />
        </pattern>
      </defs>
      <rect x="10" y="20" width="130" height="130" rx="6" fill="url(#grid)" />
      <text x="75" y="12" textAnchor="middle" className="fill-[var(--foreground)] text-[11px] font-semibold">
        original weights
      </text>
      <text x="75" y="166" textAnchor="middle" className="fill-[var(--faint)] text-[10.5px]">
        frozen · millions of numbers
      </text>
      <text x="165" y="92" textAnchor="middle" className="fill-[var(--foreground)] text-[22px]">
        +
      </text>
      <rect x="195" y="20" width="16" height="130" rx="4" fill="var(--primary)" opacity="0.85" />
      <text x="203" y="12" textAnchor="middle" className="fill-[var(--primary)] text-[11px] font-semibold">
        A
      </text>
      <text x="228" y="92" textAnchor="middle" className="fill-[var(--foreground)] text-[16px]">
        ×
      </text>
      <rect x="245" y="77" width="130" height="16" rx="4" fill="var(--primary)" opacity="0.85" />
      <text x="310" y="70" textAnchor="middle" className="fill-[var(--primary)] text-[11px] font-semibold">
        B
      </text>
      <text x="285" y="166" textAnchor="middle" className="fill-[var(--faint)] text-[10.5px]">
        trained · a small adapter (rank = thickness)
      </text>
      <text x="400" y="92" textAnchor="middle" className="fill-[var(--foreground)] text-[22px]">
        =
      </text>
      <rect x="425" y="20" width="130" height="130" rx="6" fill="url(#grid)" />
      <rect x="425" y="20" width="130" height="130" rx="6" fill="var(--primary)" opacity="0.14" />
      <text x="490" y="12" textAnchor="middle" className="fill-[var(--foreground)] text-[11px] font-semibold">
        fine-tuned weights
      </text>
      <text x="490" y="166" textAnchor="middle" className="fill-[var(--faint)] text-[10.5px]">
        merged when saved
      </text>
    </svg>
  );
}

/** Three loss curves: healthy, could use more passes, not learning. */
function LossShapesFigure() {
  const w = 170,
    h = 90;
  const curve = (f: (t: number) => number) =>
    Array.from({ length: 40 }, (_, i) => {
      const t = i / 39;
      return `${i ? "L" : "M"}${(t * w).toFixed(1)},${(h - f(t) * h * 0.85 - 4).toFixed(1)}`;
    }).join(" ");
  const shapes = [
    { title: "Healthy", text: "Falls quickly, then levels off.", f: (t: number) => 0.15 + 0.85 * Math.exp(-5 * t) + 0.03 * Math.sin(t * 40) * (1 - t), color: "var(--good)" },
    { title: "Still learning", text: "Still dropping at the end: try more passes.", f: (t: number) => 1 - 0.75 * t + 0.03 * Math.sin(t * 37), color: "var(--warn)" },
    { title: "Not learning", text: "Flat or jumping: check labels and learning rate.", f: (t: number) => 0.7 + 0.15 * Math.sin(t * 23) + 0.08 * Math.sin(t * 61), color: "var(--bad)" },
  ];
  return (
    <div className="grid grid-cols-3 gap-5">
      {shapes.map((s) => (
        <div key={s.title}>
          <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
            <line x1="0" x2={w} y1={h - 1} y2={h - 1} stroke="var(--border)" />
            <path d={curve(s.f)} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          <div className="mt-1 text-[12px] font-semibold">{s.title}</div>
          <div className="text-[11.5px] text-muted-foreground">{s.text}</div>
        </div>
      ))}
    </div>
  );
}

function CalibrationFigure() {
  const s = 150;
  const pt = (c: number, a: number) => `${(c * s).toFixed(1)},${(s - a * s).toFixed(1)}`;
  const over = [
    [0.55, 0.38],
    [0.7, 0.5],
    [0.85, 0.62],
    [0.97, 0.74],
  ];
  const good = [
    [0.55, 0.53],
    [0.7, 0.71],
    [0.85, 0.84],
    [0.97, 0.95],
  ];
  return (
    <div className="flex items-center gap-8">
      <svg viewBox={`-6 -6 ${s + 12} ${s + 12}`} className="w-[190px] shrink-0">
        <rect x="0" y="0" width={s} height={s} fill="none" stroke="var(--border)" />
        <line x1="0" y1={s} x2={s} y2="0" stroke="var(--faint)" strokeDasharray="4 4" />
        <polyline points={over.map(([c, a]) => pt(c, a)).join(" ")} fill="none" stroke="var(--faint)" strokeWidth="2" />
        <polyline points={good.map(([c, a]) => pt(c, a)).join(" ")} fill="none" stroke="var(--primary)" strokeWidth="2.4" />
        {good.map(([c, a], i) => (
          <circle key={i} cx={c * s} cy={s - a * s} r="3.5" fill="var(--primary)" />
        ))}
      </svg>
      <div className="text-[12.5px] text-muted-foreground">
        <p className="my-0">
          Across: how sure the model said it was. Up: how often it was actually right. The <B>dashed line</B> is perfect calibration.
        </p>
        <p className="mt-2 mb-0">
          <span className="font-semibold text-faint">Grey</span>: over-confident, typical before training — it says 85% and is right 62% of the time.{" "}
          <span className="font-semibold text-primary">Blue</span>: after calibration, its 85% means about 85%.
        </p>
      </div>
    </div>
  );
}

// ---- the text -------------------------------------------------------------------------------

function Content() {
  const { go } = useApp();
  return (
    <>
      <H2 id="models" kicker="Basics">
        Decision models and LLMs
      </H2>
      <P>
        ClassifAI asks models <B>questions about your text</B>: pick one label, yes or no, a score. Two kinds of models can answer them, and the app treats both the same way.
      </P>
      <P>
        <B>Decision models</B> are built for this. They read the input and the question, and give a probability for every option straight from the model. They are small (a few hundred million to a few
        billion weights), fast, run on your Mac, and can't wander off-topic: they can only pick one of your options. Laya, Clef and every fine-tune you make are decision models.
      </P>
      <P>
        <B>LLMs</B> such as Claude or GPT answer through structured output. They reason better about long, subtle text and can write free text, but they are slower, cost money per request, and their
        probabilities are their own estimates rather than measured.
      </P>

      <H2 id="evaluations">Evaluations and ground truth</H2>
      <P>
        An <B>evaluation</B> runs labelled rows through several models and compares each answer with the <B>ground truth</B>: the label a person (or a trusted process) gave that row. That turns “seems
        good” into numbers you can compare: accuracy, F1, calibration error. Everything about fine-tuning rests on this. You can only teach a model with labelled rows, and you can only know whether
        it improved by testing it on labelled rows it hasn't seen.
      </P>

      <H2 id="finetuning" kicker="Fine-tuning">
        What fine-tuning is
      </H2>
      <P>
        A base model knows language and how to make decisions in general. It doesn't know <i>your</i> labels: what counts as “billing” in your support queue, which abstracts your review includes, how
        your team codes an interview. <B>Fine-tuning</B> shows it many of your labelled examples and adjusts it a little after each one, until it answers the way your labels do.
      </P>
      <P>
        The result is a new model, named <T>ft:your-name</T>. It runs on your Mac like any other and appears in the Playground, Bulk and evaluations. Training happens on your Mac's GPU too: your data
        never leaves it.
      </P>
      <Callout title="In one sentence">
        Fine-tuning turns a general decision model into a specialist for your questions, using the labels you already have, and then proves on held-out rows whether it got better.
      </Callout>

      <H2 id="when">When it's worth it</H2>
      <Table
        head={["Good sign", "Why"]}
        rows={[
          ["A few hundred labelled rows or more", "Encoders like Laya learn from 300–2,000 rows. A model with a new head needs more, since it starts from nothing."],
          ["Off-the-shelf models score poorly", "Your labels have their own meaning. In the PubMed test, Laya went from 59% to 80% with 860 rows."],
          ["You'll classify a lot", "A fine-tuned local model is free per request and answers in ~100 ms, compared with paying an LLM for every row."],
          ["Your labels are consistent", "The model learns what the labels say. If two people would label the same row differently, it learns the confusion too."],
        ]}
      />
      <Callout tone="warn" title="When to wait">
        <p>With fewer than ~100 labelled rows, label more first (Manual labelling is built for that). If labels are inconsistent, review them first: the evaluation's review queue shows rows where models disagree with the label.</p>
      </Callout>

      <H2 id="pipeline">What happens when you start</H2>
      <P>You set up a fine-tune like an evaluation — dataset, input columns, questions and the label column for each — then choose a base model and the models to compare against.</P>
      <Figure caption="Every fine-tune runs these steps in order. The job page shows which one is running and explains it.">
        <PipelineFigure />
      </Figure>
      <P>
        <B>1. Split.</B> A share of the labelled rows (20% by default) is set aside as the <B>test set</B>, before anything else happens. <B>2. Compare.</B> The models you picked answer those rows.
        That's the bar to beat, measured on exactly the rows the fine-tune will be tested on. <B>3. Train.</B> The base model learns from most of the remaining rows. <B>4. Calibrate.</B> A small
        slice tunes how confident it is. <B>5. Save.</B> The result is written as one 8-bit file. <B>6. Test.</B> The fine-tune answers the test rows and joins the comparison models in the same
        evaluation, so you read before and after in one leaderboard.
      </P>

      <H2 id="split">Train, calibrate, test</H2>
      <Figure caption="The default split. Each label keeps its share in every part (a stratified split), so a rare label isn't missing from the test.">
        <SplitFigure />
      </Figure>
      <P>
        Why three parts? A model is always good on the rows it trained on: it has seen the answers. Testing on them would be like grading an exam with the questions handed out the day before. The{" "}
        <B>test set</B> is kept away from every step that shapes the model, so its score is an honest estimate of how it will do on new rows.
      </P>
      <P>
        The <B>calibration set</B> is separate again, because calibration is also fitted, so it needs rows the model didn't train on. The test rows are saved as their own dataset (“… held out for …”)
        and are never offered for training another fine-tune.
      </P>

      <H2 id="bases">Choosing a base model</H2>
      <Table
        head={["Base", "Kind", "Choose it when", "Time for 1,000 rows"]}
        rows={[
          ["Laya English", "Encoder · 421M", "English text up to ~500 tokens. The default: fast and accurate.", "~2 min per pass"],
          ["Laya multilingual", "Encoder · 322M", "Other languages, or a mix.", "~2 min per pass"],
          ["Qwen3.5 0.8B + new head", "Language model", "Longer inputs (up to ~2,000 tokens). Starts from zero, so it wants more rows.", "~7 min per pass"],
          ["Qwen3.5 2B + new head", "Language model", "Harder questions and long text, with plenty of rows.", "~17 min per pass"],
          ["Clef Flash", "Language model · 9B", "The most accurate base, if you have the memory (48 GB) and hours.", "over an hour"],
        ]}
      />
      <P>
        An <B>encoder</B> reads the whole input at once and is built for understanding. That makes it quick and data-efficient. A <B>language model</B> reads token by token and handles longer, more
        complex text. A “new head” means it gets a fresh decision layer that has never seen a decision before: it starts near chance and learns everything from your rows.
      </P>

      <H2 id="training">How training works</H2>
      <P>
        Training runs in <B>steps</B>. Each step takes a <B>batch</B> of 8 labelled rows. The model answers them, the answers are compared with your labels, and every weight that takes part is nudged
        slightly in the direction that would have made the right answers more likely. One <B>pass</B> (or epoch) means every training row has been seen once. “Standard” effort is two passes.
      </P>
      <P>
        The <B>loss</B> measures how surprised the model is by the right answers: high when it gives the correct label a low probability, near zero when it's confidently right. You watch it fall
        during training. The <B>learning rate</B> sets the size of each nudge. Too large and the loss jumps around; too small and it barely moves.
      </P>
      <Figure caption="What the loss curve tells you. Some noise between steps is normal; look at the trend.">
        <LossShapesFigure />
      </Figure>
      <Callout tone="tip" title="Over-fitting">
        A model can learn the training rows too well: it memorises them instead of the pattern, and gets worse on new rows. The held-out test catches this. If the fine-tune is great on the
        calibration rows but not on the test, or “unlearned” rows pile up, use fewer passes or more data.
      </Callout>

      <H2 id="lora">LoRA and the decision head</H2>
      <P>
        Changing all of a model's weights is slow, needs a lot of memory, and tends to make it forget what it already knew. <B>LoRA</B> (low-rank adaptation) instead freezes the original weights and
        trains small add-on matrices next to them. Their product is a correction added to the original. For Laya that's about 33 million of 428 million weights (8%).
      </P>
      <Figure caption="LoRA in one picture: the big matrix stays as it is; the two thin ones learn the change. The rank is their thickness (16 by default).">
        <LoraFigure />
      </Figure>
      <P>
        The <B>decision head</B> is the last layer: it turns what the model understood into one score per option, which becomes the probabilities you see. It's trained fully, since it's where your
        labels live. When the model is saved, the adapters are merged in, so the result is one ordinary model.
      </P>

      <H2 id="calibration">Calibration</H2>
      <P>
        A model is <B>calibrated</B> when its confidence means what it says: of all the answers it gives with 80% confidence, about 80% are right. Calibration doesn't change which answer wins; it
        makes the percentages trustworthy, so you can let sure answers through and only review unsure ones.
      </P>
      <Figure caption="A reliability diagram, as on the fine-tune page under “Confidence you can trust”.">
        <CalibrationFigure />
      </Figure>
      <P>
        After training, a <B>temperature</B> is fitted on the calibration rows for each kind of question. Dividing the model's scores by a temperature above 1 softens over-confident answers; below 1
        sharpens timid ones. The <B>calibration error (ECE)</B> sums up the gap between stated confidence and actual accuracy. Lower is better, and under 0.05 is good.
      </P>

      <H2 id="results">Reading the results</H2>
      <H3>The held-out test</H3>
      <P>
        This is the number that counts: the fine-tune and the comparison models on the same unseen rows. <B>Accuracy</B> is the share answered right. <B>Macro F1</B> averages performance over the
        labels equally, so a rare label counts as much as a common one; it's the better single number when labels are unbalanced. <B>κ (kappa)</B> is agreement with your labels beyond what chance
        would give: 0 is chance, 1 is perfect, above 0.8 is strong. Open the evaluation for the confusion matrix and the rows it got wrong.
      </P>
      <H3>What it learned</H3>
      <P>
        Every calibration row is answered before and after training. <B>Learned</B> rows were wrong and are now right. <B>Unlearned</B> rows were right and are now wrong; a few are normal, many
        suggest over-fitting. <B>Still wrong</B> rows are worth reading: they are often ambiguous, mislabelled, or a label with too few examples. The per-label view shows which labels gained most.
      </P>

      <H2 id="tips">Getting better results</H2>
      <ul className="my-3 list-disc space-y-1.5 pl-5">
        <li>
          <B>Fix labels before adding passes.</B> Check “still wrong” rows and the evaluation's review queue; mislabelled rows teach the wrong thing.
        </li>
        <li>
          <B>Give rare labels examples.</B> A label with fewer than ~10 rows is rarely learned. Label more of it, or merge it into a broader label.
        </li>
        <li>
          <B>More rows beat more passes.</B> Going from 300 to 1,000 labelled rows usually helps more than a third pass.
        </li>
        <li>
          <B>Keep the wording.</B> The fine-tune learns your question and label descriptions as they are. Ask it the same way afterwards.
        </li>
        <li>
          <B>Long text?</B> Laya reads about 500 tokens and cuts the rest; the setup warns you. Use a Qwen base for long documents.
        </li>
      </ul>

      <H2 id="under-the-hood">Under the hood</H2>
      <P>
        Training uses <B>Unsloth</B> on Apple's <B>MLX</B>, which runs on the Mac's GPU. The model is saved as a <B>GGUF</B> file with 8-bit weights and served by <B>llama.cpp</B>, which answers through
        the same decision API as every other model. One server runs all your fine-tunes and loads each on its first request.
      </P>
      <P>
        Setting up the trainer installs Python, PyTorch, MLX, Unsloth and llama.cpp into ClassifAI's own folder (about 1.5 GB). Nothing is installed system-wide, and you can remove it from the
        Fine-tune page. Base model weights are downloaded once from Hugging Face. Training data, logs and results of each fine-tune are in its folder (the Files button on its page).
      </P>
      <Callout title="Licences">
        Unsloth's decision-model code is AGPL-3.0, so it's never part of ClassifAI. It's installed separately and run as its own process. llama.cpp is MIT. Laya, Clef and Qwen3.5 are Apache-2.0.
      </Callout>
      <Button className="mt-2" onClick={() => go({ page: "finetune" })}>
        Go to Fine-tune
      </Button>

      <Glossary />
    </>
  );
}

const TERMS: [string, string][] = [
  ["Accuracy", "The share of rows answered with the right label."],
  ["Base model", "The model a fine-tune starts from. It stays unchanged; the fine-tune is a new model."],
  ["Batch", "The rows the model sees in one training step (8 here)."],
  ["Calibration", "How well a model's confidence matches how often it's right. Fitted after training on the calibration set."],
  ["Calibration set", "A small slice of labelled rows used to fit the temperature and measure before/after; not trained on."],
  ["Cohen's κ (kappa)", "Agreement with the ground truth beyond chance. 0 = chance, 1 = perfect."],
  ["Decision head", "The last layer of a decision model: one score per option, turned into probabilities."],
  ["Decision model", "A model that picks among your options with a probability for each, instead of writing text."],
  ["ECE", "Expected calibration error: the average gap between stated confidence and actual accuracy. Lower is better."],
  ["Encoder", "A model that reads the whole input at once (like Laya). Fast and data-efficient for understanding text."],
  ["Epoch (pass)", "One full round through all training rows."],
  ["Fine-tuning", "Training an existing model further on your own labelled examples."],
  ["GGUF", "The file format llama.cpp runs. A fine-tune is saved as one GGUF file."],
  ["Ground truth", "The trusted label of a row, which answers are scored against."],
  ["Held-out (test) set", "Labelled rows kept away from training, used only for the final, fair comparison."],
  ["Language model (decoder)", "A model that reads token by token (like Qwen). Handles longer, more complex text; slower."],
  ["Learning rate", "How big each adjustment during training is."],
  ["LoRA", "Low-rank adaptation: train small add-on matrices instead of all weights. Fast, light, and less forgetting."],
  ["Loss", "How surprised the model is by the right answers. Training pushes it down."],
  ["Macro F1", "F1 (balance of precision and recall) averaged over labels equally, so rare labels count fully."],
  ["MLX", "Apple's machine-learning framework for the GPU in Apple silicon."],
  ["Over-fitting", "Memorising the training rows instead of the pattern; shows up as worse results on held-out rows."],
  ["Quantization (8-bit)", "Storing weights with fewer bits. Smaller and faster with very little loss of accuracy."],
  ["Rank", "The size of the LoRA adapters. Higher can learn more and over-fit sooner."],
  ["Seed", "A number that fixes the random split and order, so a run can be repeated exactly."],
  ["Step", "One update of the model, after one batch."],
  ["Stratified split", "A split where each label keeps its share in train, calibration and test."],
  ["Temperature", "A number the model's scores are divided by. Tuning it calibrates confidence without changing the winner."],
  ["Token", "A piece of a word. Models count input length in tokens (about ¾ of a word in English)."],
];

function Glossary() {
  const [q, setQ] = useState("");
  const shown = useMemo(() => TERMS.filter(([t, d]) => !q.trim() || `${t} ${d}`.toLowerCase().includes(q.trim().toLowerCase())), [q]);
  return (
    <>
      <H2 id="glossary" kicker="Reference">
        Glossary
      </H2>
      <div className="mt-3 mb-4 flex items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Find a term…" className="w-64" />
        {q && <span className="text-[12px] text-faint">{shown.length} of {TERMS.length}</span>}
      </div>
      <dl className="divide-y divide-border rounded-[12px] border border-border">
        {shown.map(([t, d]) => (
          <div key={t} className="grid grid-cols-[12rem_minmax(0,1fr)] gap-4 px-4 py-2.5 text-[12.5px]">
            <dt className="font-semibold text-foreground">{t}</dt>
            <dd className="text-muted-foreground">{d}</dd>
          </div>
        ))}
        {shown.length === 0 && (
          <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-faint">
            <Search className="size-3.5" /> No term matches.
          </div>
        )}
      </dl>
    </>
  );
}
