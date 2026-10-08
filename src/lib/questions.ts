/** Mirrors `task::compose_instructions` in classifai-core: context is appended to the instructions. */
export function composeInstructions(instructions: string, ...contexts: (string | null | undefined)[]): string {
  const base = instructions.trim();
  const joined = contexts.map((c) => (c ?? "").trim()).filter(Boolean).join("\n");
  return joined ? `${base}\n\nContext: ${joined}`.trim() : base;
}

/** A readable, unique question id from a title: "Is it recurring?" -> "is_it_recurring". */
export function slugId(title: string, taken: string[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 28) || "question";
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}_${i}`;
  return id;
}
