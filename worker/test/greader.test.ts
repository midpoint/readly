import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GREADER_USERNAME, SETTING_KEYS } from "@readly/shared";
import { deriveToken } from "../src/lib/greader";
import { putSetting } from "../src/lib/settings";

const PASSWORD = "0123456789abcdef0123456789abcdef";
let token = "";

async function enable(): Promise<string> {
  await putSetting(env.DB, SETTING_KEYS.greaderAuth, { username: GREADER_USERNAME, password: PASSWORD });
  token = await deriveToken({ username: GREADER_USERNAME, password: PASSWORD });
  return token;
}

function loginBody(output?: string): URLSearchParams {
  const body = new URLSearchParams({ Email: GREADER_USERNAME, Passwd: PASSWORD });
  if (output) body.set("output", output);
  return body;
}

async function clientLogin(body: URLSearchParams): Promise<Response> {
  return SELF.fetch("http://example.com/accounts/ClientLogin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function authed(path: string, opts: { method?: string; body?: URLSearchParams } = {}): Promise<Response> {
  return SELF.fetch(`http://example.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `GoogleLogin auth=${token}`,
      ...(opts.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: opts.body?.toString(),
  });
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM article_states; DELETE FROM articles; DELETE FROM feeds; DELETE FROM categories; DELETE FROM settings;");
  token = "";
});

describe("ClientLogin", () => {
  it("正确凭据返回三行文本令牌", async () => {
    const expected = await enable();
    const res = await clientLogin(loginBody());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe(`SID=${expected}\nLSID=${expected}\nAuth=${expected}\n`);
  });

  it("output=json 返回 JSON 令牌", async () => {
    const expected = await enable();
    const res = await clientLogin(loginBody("json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ SID: expected, LSID: expected, Auth: expected });
  });

  it("GET 查询参数同样可用", async () => {
    const expected = await enable();
    const url = new URL("http://example.com/accounts/ClientLogin");
    url.search = loginBody().toString();
    const res = await SELF.fetch(url.toString());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Auth=${expected}`);
  });

  it("错误密码与未配置均 401", async () => {
    await enable();
    const wrong = new URLSearchParams({ Email: GREADER_USERNAME, Passwd: "wrong" });
    expect((await clientLogin(wrong)).status).toBe(401);
    await env.DB.exec("DELETE FROM settings");
    expect((await clientLogin(loginBody())).status).toBe(401);
  });
});

describe("令牌与用户信息", () => {
  it("token 端点返回同一令牌", async () => {
    const expected = await enable();
    const res = await authed("/reader/api/0/token");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expected);
  });

  it("user-info 返回标准字段", async () => {
    await enable();
    const res = await authed("/reader/api/0/user-info");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      userId: "1",
      userName: GREADER_USERNAME,
      userProfileId: "1",
      userEmail: GREADER_USERNAME,
    });
  });

  it("缺失/错误 / 非 GoogleLogin 头均 401", async () => {
    await enable();
    expect((await SELF.fetch("http://example.com/reader/api/0/user-info")).status).toBe(401);
    const wrong = await SELF.fetch("http://example.com/reader/api/0/user-info", {
      headers: { Authorization: "GoogleLogin auth=readly/deadbeef" },
    });
    expect(wrong.status).toBe(401);
    const bearer = await SELF.fetch("http://example.com/reader/api/0/user-info", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bearer.status).toBe(401);
  });

  it("/api/* 仍受 AUTH_TOKEN 保护", async () => {
    await enable();
    expect((await SELF.fetch("http://example.com/api/articles")).status).toBe(401);
  });
});
