import { describe, expect, it } from "vitest";
import { assertSafeUrl, isForbiddenHost } from "../src/lib/ssrf";

describe("isForbiddenHost", () => {
  const forbidden = [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.8",
    "172.16.5.5",
    "172.31.255.1",
    "192.168.1.1",
    "169.254.1.1",
    "0.0.0.0",
    "[::1]",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "localhost.",
    "app.localhost.",
    "x.local.",
    "x.internal.",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[::ffff:192.168.0.1]",
    "[::ffff:10.0.0.1]",
    "[64:ff9b::7f00:1]",
    "[64:ff9b::10.0.0.1]",
    "[2002:7f00:1::]",
    "[2001:0:4136:e378:8000:63bf:3fff:fdd2]",
    "[2001::1]",
    "[2001:0:0:1:2:3:4:5]",
    "[::127.0.0.1]",
    "[::7f00:1]",
  ];
  for (const host of forbidden) {
    it(`拒绝 ${host}`, () => expect(isForbiddenHost(host)).toBe(true));
  }
  const allowed = ["example.com", "8.8.8.8", "172.32.0.1", "192.169.0.1", "fe00::1", "[::ffff:8.8.8.8]", "[2606:4700::1111]", "[::8.8.8.8]", "[::808:808]"];
  for (const host of allowed) {
    it(`允许 ${host}`, () => expect(isForbiddenHost(host)).toBe(false));
  }
});

describe("assertSafeUrl", () => {
  it("拒绝非 http(s) 协议", () => {
    expect(() => assertSafeUrl("ftp://example.com/x")).toThrow(/仅支持/);
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/仅支持/);
  });
  it("拒绝私网", () => {
    expect(() => assertSafeUrl("http://192.168.0.10/feed")).toThrow(/内网/);
  });
  it("拒绝带尾点的 localhost", () => {
    expect(() => assertSafeUrl("http://localhost./x")).toThrow(/内网/);
  });
  it("拒绝 IPv4 映射的 IPv6 字面量", () => {
    expect(() => assertSafeUrl("http://[::ffff:127.0.0.1]/x")).toThrow(/内网/);
  });
  it("合法 URL 返回 URL 对象", () => {
    expect(assertSafeUrl("https://example.com/feed.xml").hostname).toBe("example.com");
  });
  it("非法 URL 抛错", () => {
    expect(() => assertSafeUrl("not a url")).toThrow(/无效/);
  });
});
