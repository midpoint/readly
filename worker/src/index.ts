import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "./env";
import { authMiddleware } from "./auth";
import { fail } from "./respond";
import ai from "./routes/ai";
import articles from "./routes/articles";
import auth from "./routes/auth";
import categories from "./routes/categories";
import feeds from "./routes/feeds";
import greader from "./routes/greader";
import health from "./routes/health";
import proxy from "./routes/proxy";
import refreshRoutes from "./routes/refresh";
import settingsRoutes from "./routes/settings";
import stats from "./routes/stats";
import { refreshDueFeeds } from "./lib/refresh";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", authMiddleware);
app.route("/api", health);
app.route("/api", auth);
app.route("/api", categories);
app.route("/api", feeds);
app.route("/api", articles);
app.route("/api", ai);
app.route("/api", stats);
app.route("/api", settingsRoutes);
app.route("/api", refreshRoutes);
app.route("/api", proxy);
app.route("/", greader);

app.notFound((c) => fail(c, 404, "not_found", "接口不存在"));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return fail(c, 500, "internal_error", "服务器内部错误");
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      refreshDueFeeds(env.DB).then((r) => {
        console.log(`[readly] scheduled refresh: processed=${r.processed} remaining=${r.remaining} done=${r.done}`);
      })
    );
  },
} satisfies ExportedHandler<Env>;
