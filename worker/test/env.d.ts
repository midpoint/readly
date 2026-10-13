import type { D1Migration } from "cloudflare:test";
import type { Env } from "../src/env";

// 补充 `cloudflare:test` 的 `env` 类型:DB/AUTH_TOKEN 来自 wrangler.toml 与 vitest 配置,
// TEST_MIGRATIONS 由 vitest.config.ts 的 miniflare.bindings 注入。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
