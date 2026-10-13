function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function hexWordsToIpv4(hi: string, lo: string): string {
  const a = parseInt(hi, 16);
  const b = parseInt(lo, 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

function isPrivateIpv6(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(h)) return true;
  // NAT64 知名前缀、6to4、Teredo:字面出现在用户 URL 中一律视为恶意
  if (h.startsWith("64:ff9b:") || h.startsWith("2002:") || h.startsWith("2001:0:") || h.startsWith("2001::")) return true;
  // IPv4-mapped IPv6:URL 解析器把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1 的十六进制形式
  if (h.startsWith("::ffff:")) {
    const tail = h.slice(7);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) return isPrivateIpv4(hexWordsToIpv4(hex[1]!, hex[2]!));
    return isPrivateIpv4(tail);
  }
  // IPv4-compatible(::x.y):URL 解析器规范化为 ::<hex>:<hex>,直接调用时可能仍是点分形式
  if (h.startsWith("::")) {
    const rest = h.slice(2);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) return isPrivateIpv4(hexWordsToIpv4(hex[1]!, hex[2]!));
    return isPrivateIpv4(rest);
  }
  return false;
}

export function isForbiddenHost(hostname: string): boolean {
  // 只去一个尾点:URL 保留域名尾点,localhost. 会被系统解析为 127.0.0.1
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("无效的 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅支持 http/https 地址");
  }
  if (isForbiddenHost(url.hostname)) {
    throw new Error("不允许访问内网地址");
  }
  return url;
}
