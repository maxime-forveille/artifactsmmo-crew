import * as v from "valibot";

const envSchema = v.object({
  ARTIFACTS_TOKEN: v.pipe(v.string(), v.minLength(1, "ARTIFACTS_TOKEN is required")),
  DISCORD_WEBHOOK_URL: v.optional(v.pipe(v.string(), v.url())),
  ENABLE_NOTIFICATIONS: v.pipe(
    v.optional(v.string(), "false"),
    v.transform((value) => value === "true"),
  ),
  LOG_LEVEL: v.optional(
    v.picklist(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
    "info",
  ),
  NODE_ENV: v.optional(v.picklist(["development", "production", "test"]), "development"),
});

export type Env = v.InferOutput<typeof envSchema>;

function loadEnv(): Env {
  const result = v.safeParse(envSchema, process.env);

  if (!result.success) {
    const issues = result.issues
      .map((issue) => `  - ${v.getDotPath(issue) ?? "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.output;
}

export const env = loadEnv();
