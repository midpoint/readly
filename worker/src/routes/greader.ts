import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../auth";
import { deriveToken, googleLoginToken, loadCredentials } from "../lib/greader";

const NO_STORE = { "Cache-Control": "no-store" };
const greader = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

export interface MultiParams {
  add(key: string, value: string): void;
  get(key: string): string | undefined;
  getAll(key: string): string[];
}

function createMultiParams(): MultiParams {
  const map = new Map<string, string[]>();
  return {
    add(key, value) {
      const list = map.get(key) ?? [];
      list.push(value);
      map.set(key, list);
    },
    get(key) {
      return map.get(key)?.[0];
    },
    getAll(key) {
      return map.get(key) ?? [];
    },
  };
}

async function collectParams(c: Ctx): Promise<MultiParams> {
  const params = createMultiParams();
  new URL(c.req.url).searchParams.forEach((value, key) => params.add(key, value));
  if (c.req.method === "POST") {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      for (const [key, value] of Object.entries(body)) {
        if (typeof value === "string") params.add(key, value);
      }
    } else {
      const form = await c.req.raw.formData().catch(() => null);
      form?.forEach((value, key) => {
        if (typeof value === "string") params.add(key, value);
      });
    }
  }
  return params;
}

greader.use("/reader/*", async (c, next) => {
  const credentials = await loadCredentials(c.env.DB);
  const provided = googleLoginToken(c.req.header("Authorization"));
  if (!credentials || !provided) return c.text("Unauthorized", 401, NO_STORE);
  const expected = await deriveToken(credentials);
  if (!timingSafeEqualStr(provided, expected)) return c.text("Unauthorized", 401, NO_STORE);
  return next();
});

greader.on(["GET", "POST"], "/accounts/ClientLogin", async (c) => {
  const credentials = await loadCredentials(c.env.DB);
  const params = await collectParams(c);
  if (
    !credentials ||
    params.get("Email") !== credentials.username ||
    params.get("Passwd") !== credentials.password
  ) {
    return c.text("Unauthorized", 401, NO_STORE);
  }
  const token = await deriveToken(credentials);
  if (params.get("output") === "json") {
    return c.json({ SID: token, LSID: token, Auth: token }, 200, NO_STORE);
  }
  return c.text(`SID=${token}\nLSID=${token}\nAuth=${token}\n`, 200, NO_STORE);
});

greader.get("/reader/api/0/token", async (c) => {
  const credentials = await loadCredentials(c.env.DB);
  if (!credentials) return c.text("Unauthorized", 401, NO_STORE);
  return c.text(await deriveToken(credentials), 200, NO_STORE);
});

greader.get("/reader/api/0/user-info", async (c) => {
  const credentials = await loadCredentials(c.env.DB);
  if (!credentials) return c.text("Unauthorized", 401, NO_STORE);
  return c.json(
    {
      userId: "1",
      userName: credentials.username,
      userProfileId: "1",
      userEmail: credentials.username,
      isBloggerUser: false,
      signupTimeSec: 0,
      isMultiLoginEnabled: false,
    },
    200,
    NO_STORE
  );
});

export default greader;
