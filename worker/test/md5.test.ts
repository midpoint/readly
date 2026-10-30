import { describe, expect, it } from "vitest";
import { md5Hex } from "../src/lib/md5";

describe("md5Hex", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
    ["中文", "a7bac2239fcdcb3a067903d8077c4a07"],
    ["readly:0123456789abcdef0123456789abcdef", "b580a0c062176f0a30727fa9b23682f2"],
  ])("md5(%j) = %s", (input, expected) => {
    expect(md5Hex(input)).toBe(expected);
  });

  it("覆盖 55/56/64 字节边界", () => {
    expect(md5Hex("a".repeat(55))).toBe("ef1772b6dff9a122358552954ad0df65");
    expect(md5Hex("a".repeat(56))).toBe("3b0c8ac703f828b04c6c197006d17218");
    expect(md5Hex("a".repeat(64))).toBe("014842d480b571495a4a0363793f7367");
  });
});
