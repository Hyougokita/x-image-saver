import test from "node:test";
import assert from "node:assert/strict";
import { imageUrls, imageFormat, imageFilename, bytesToBase64, isAllowedPage, validateFolders } from "../extension/core.js";

test("请求原图并保留显示图作为备用，支持新旧推特图片地址", () => {
  assert.deepEqual(imageUrls("https://pbs.twimg.com/media/AbC?format=png&name=small"), [
    "https://pbs.twimg.com/media/AbC?format=png&name=orig", "https://pbs.twimg.com/media/AbC?format=png&name=small"
  ]);
  assert.deepEqual(imageUrls("https://pbs.twimg.com/media/AbC.jpg:large"), [
    "https://pbs.twimg.com/media/AbC?format=jpg&name=orig", "https://pbs.twimg.com/media/AbC.jpg:large"
  ]);
  assert.deepEqual(imageUrls("https://pbs.twimg.com/profile_images/123/photo.jpg"), ["https://pbs.twimg.com/profile_images/123/photo.jpg"]);
  assert.equal(imageUrls("https://pbs.twimg.com/media/AbC?format=jpg&name=orig").length, 1);
  assert.equal(imageUrls("https://pbs.twimg.com/media/AbC.jpg", false).length, 1);
});

test("拒绝非推特服务器、伪造域名、本机地址及带凭据的地址", () => {
  for (const url of ["https://evil.test/image.jpg", "https://pbs.twimg.com.evil.test/a.jpg", "http://pbs.twimg.com/a.jpg", "https://127.0.0.1/image", "file:///D:/image.jpg", "https://a:b@pbs.twimg.com/a", "https://pbs.twimg.com:8080/a"]) {
    assert.throws(() => imageUrls(url));
  }
  assert.equal(isAllowedPage("https://x.com/user/status/123"), true);
  assert.equal(isAllowedPage("https://www.twitter.com/user"), true);
  assert.equal(isAllowedPage("https://x.com.attacker.test/user"), false);
});

test("根据字节识别图片，拒绝服务器错误页面", () => {
  assert.equal(imageFormat(Uint8Array.from([137,80,78,71,13,10,26,10,0])), "png");
  assert.equal(imageFormat(Uint8Array.from([255,216,255,0])), "jpg");
  assert.equal(imageFormat(new TextEncoder().encode("RIFF0000WEBPVP8 ")), "webp");
  assert.throws(() => imageFormat(new TextEncoder().encode("<html>Error</html>")));
  assert.throws(() => imageFormat(new Uint8Array()));
});

test("文件名与 base64 编码不会丢失数据或生成路径", () => {
  assert.equal(imageFilename("https://pbs.twimg.com/media/Ab_C.jpg:large", "png"), "x_Ab_C.png");
  assert.equal(imageFilename("https://pbs.twimg.com/media/%2e%2e%2Fsecret", "jpg"), "x____secret.jpg");
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  assert.deepEqual(Buffer.from(bytesToBase64(bytes), "base64"), Buffer.from(bytes));
});

test("目录配置要求完整 Windows 路径，并防止编号重复", () => {
  const folder = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", name: "  插画  ", path: " D:\\图片\\插画 " };
  assert.equal(validateFolders([folder])[0].name, "插画");
  assert.throws(() => validateFolders([{ ...folder, path: "../Pictures" }]));
  assert.throws(() => validateFolders([folder, folder]));
  assert.throws(() => validateFolders([{ ...folder, name: "" }]));
});
