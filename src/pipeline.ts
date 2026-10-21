import type { Stage } from "./harness/runner";
import { collectStage } from "./stages/collect";
import { motionStage } from "./stages/motion";
import { reelsStage } from "./stages/reels";
import { storiesStage } from "./stages/stories";
import { verifyStage } from "./stages/verify";

// The daily pipeline: collect → Writer ⇄ Editor → Director ⇄ Readers → Explainer ⇄ Viewer (when asked) → check.
export const daily: Stage[] = [collectStage, storiesStage, reelsStage, motionStage, verifyStage];
