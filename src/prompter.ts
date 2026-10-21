import * as clack from "@clack/prompts";
import type { Prompter } from "./harness/plugin";

// The installer's questions in a terminal. Ctrl-C at any question leaves without writing anything.
function answered<T>(v: T | symbol): T {
  if (clack.isCancel(v)) {
    clack.cancel("Nothing was written.");
    process.exit(1);
  }
  return v as T;
}

export const terminal: Prompter = {
  text: async (q) => answered<string>(await clack.text({ message: q.message, initialValue: q.initial, placeholder: q.placeholder, validate: q.validate ? (v) => q.validate?.(v ?? "") : undefined })),
  confirm: async (q) => answered<boolean>(await clack.confirm({ message: q.message, initialValue: q.initial })),
  select: async (q) => answered(await clack.select({ message: q.message, options: q.options as never, initialValue: q.initial as never })) as never,
  multiselect: async (q) => answered(await clack.multiselect({ message: q.message, options: q.options as never, initialValues: q.initial as never, required: true })) as never,
  note: (message, title) => clack.note(message, title),
};

// Answers from flags, by question id; a question without one takes its default, and one without a default is an error.
export function answering(answers: Record<string, string | boolean | string[]>): Prompter {
  const get = (id: string) => answers[id];
  const missing = (id: string): never => {
    throw new Error(`--yes needs an answer for ${id}`);
  };
  return {
    async text(q) {
      const v = (get(q.id) as string | undefined) ?? q.initial ?? missing(q.id);
      const error = q.validate?.(v);
      if (error) throw new Error(`${q.id}: ${error}`);
      return v;
    },
    confirm: async (q) => (get(q.id) as boolean | undefined) ?? q.initial ?? missing(q.id),
    async select(q) {
      const v = (get(q.id) as string | undefined) ?? q.initial ?? missing(q.id);
      if (!q.options.some((o) => o.value === v)) throw new Error(`${q.id} is one of ${q.options.map((o) => o.value).join(", ")}`);
      return v as never;
    },
    async multiselect(q) {
      const raw = get(q.id);
      const v = raw === undefined ? (q.initial ?? missing(q.id)) : Array.isArray(raw) ? raw : String(raw).split(",");
      for (const x of v) if (!q.options.some((o) => o.value === x)) throw new Error(`${q.id}: ${x} is not one of ${q.options.map((o) => o.value).join(", ")}`);
      return v as never;
    },
    note: () => {},
  };
}
