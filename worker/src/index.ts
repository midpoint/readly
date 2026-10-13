import { Hono } from "hono";
import type { Env } from "./env";
import { authMiddleware } from "./auth";
import { fail } from "./respond";
import health from "./routes/health";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", authMiddleware);
app.route("/api", health);

app.notFound((c) => fail(c, 404, "not_found", "接口不存在"));

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Task 8 接入刷新;Task 18 配置 cron 触发器
  },
} satisfies ExportedHandler<Env>;
