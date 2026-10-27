import type { ParseArgsConfig } from "node:util";
import type { Project, System } from "../issue";
import type { Ctx } from "./context";
import type { Model } from "./model";

// How the installer asks. Each question has an id, so `--yes` and flags can answer it without a terminal.
export type Option<T extends string> = { value: T; label: string; hint?: string };
export type Prompter = {
  text(q: { id: string; message: string; initial?: string; placeholder?: string; validate?: (v: string) => string | undefined }): Promise<string>;
  confirm(q: { id: string; message: string; initial?: boolean }): Promise<boolean>;
  // Text read hidden, for a token or key; empty skips it.
  secret(q: { id: string; message: string }): Promise<string>;
  select<T extends string>(q: { id: string; message: string; options: Option<T>[]; initial?: T }): Promise<T>;
  multiselect<T extends string>(q: { id: string; message: string; options: Option<T>[]; initial?: T[] }): Promise<T[]>;
  note(message: string, title?: string): void;
};

// A source is where a day's work comes from: GitHub now, an issue tracker next. Each one is configured in
// project.json under sources.<name>, checked against its `config` schema, and collects its slice of the day.
export type Source<C = unknown, S = unknown> = {
  name: string;
  config: object;
  collect(ctx: Ctx, config: C): Promise<S>;
  // Nothing landed: when every source is empty there is no issue today.
  empty(slice: S): boolean;
  // One line for the log: what the slice holds.
  summary?(slice: S): string;
  // What would stop it collecting: a missing token, a repo it can't read. Empty when it's ready.
  doctor(config: C): Promise<string[]>;
  // The installer's questions for this source; `current` is the config a project already has.
  setup(p: Prompter, current?: C): Promise<{ config: C; env: Record<string, string>; secrets: { name: string; why: string }[] }>;
};

// A project collector keeps project-level files current, on its own schedule rather than every day:
// the Cartographer redraws system.json from what recent issues touched.
export type ProjectCtx = { root: string; project: Project; system: System; model: Model; log(msg: string): void; trace(name: string, value: unknown): Promise<unknown> };
export type ProjectCollector = {
  name: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(ctx: ProjectCtx, values: Record<string, string | boolean | string[] | boolean[] | undefined>): Promise<void>;
};
