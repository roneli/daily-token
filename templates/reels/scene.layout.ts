// A scene's markup is the Director's; this only lets through what src/scene.ts allows. Its length is the reel's own ms.
import { scene } from "../../src/scene";

export function layout(raw: Record<string, unknown>) {
  const { svg, errors } = scene(raw.svg as string);
  if (errors.length) throw new Error(`scene: ${errors.map((e) => e.detail).join("; ")}`);
  return { fields: { svg }, ms: 0 };
}
