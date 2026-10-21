import type { ProjectCollector } from "../harness/plugin";
import { briefer } from "./briefer";
import { cartographer } from "./cartographer";

export const PROJECT_COLLECTORS: ProjectCollector[] = [cartographer, briefer];
