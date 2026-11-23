import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  const bindings = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
});
