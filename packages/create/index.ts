#!/usr/bin/env bun
import { runInit } from "daily-token/src/cli";

// bun create daily-token [dir] [--yes ...]: the engine's init, from outside a data root.
await runInit(process.argv.slice(2));
