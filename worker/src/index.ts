import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env";
import { authMiddleware } from "./auth";
import { fail } from "./respond";
import auth from "./routes/auth";
import health from "./routes/health";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", authMiddleware);
app.route("/api", health);
app.route("/api", auth);

app.notFound((c) => fail(c, 404, "not_found", "接口不存在"));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return fail(c, 500, "internal_error", "服务器内部错误");
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Task 8 接入刷新;Task 18 配置 cron 触发器
  },
} satisfies ExportedHandler<Env>;
