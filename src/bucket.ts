import { S3Client } from "bun";

// Issues live in any S3-compatible bucket: AWS S3, Cloudflare R2, MinIO, Backblaze B2.
// Each setting is S3_<KEY>; R2_<KEY>, its older name, is still read.
export const BUCKET_KEYS = ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"] as const;

type Env = Record<string, string | undefined>;
const setting = (env: Env, key: string) => env[`S3_${key}`] || env[`R2_${key}`];

export const bucketSet = (env: Env = process.env) => BUCKET_KEYS.filter((k) => setting(env, k)).length;
export const bucketMissing = (env: Env = process.env) => BUCKET_KEYS.filter((k) => !setting(env, k)).map((k) => `S3_${k}`);

export function bucket(env: Env = process.env): S3Client {
  const missing = bucketMissing(env);
  if (missing.length) throw new Error(`set ${missing.join(", ")} for the issues bucket`);
  const at = (k: string) => setting(env, k) as string;
  return new S3Client({ endpoint: at("ENDPOINT"), bucket: at("BUCKET"), accessKeyId: at("ACCESS_KEY_ID"), secretAccessKey: at("SECRET_ACCESS_KEY"), region: env.S3_REGION });
}
