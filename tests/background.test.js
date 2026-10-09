import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const origin = `chrome-extension://${extensionId}/`;
const destination = "D:\\图片 收藏";
const folder = { id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", name: "插画", path: destination };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZQkAAAAASUVORK5CYII=", "base64");
const MP4 = Buffer.concat([Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex"), Buffer.alloc(300000, 7)]);
const videoLow = "https://video.twimg.com/ext_tw_video/456/pu/vid/320x240/low.mp4";
const videoHigh = "https://video.twimg.com/ext_tw_video/456/pu/vid/1280x720/high.mp4";
const poster = "https://pbs.twimg.com/ext_tw_video_thumb/456/pu/img/sample.jpg";
const hook = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, fire(...args) { this.listeners.forEach(fn => fn(...args)); } });
let store = {};
let menus = [];
let notifications = [];
let missingHost = false;
let launches = 0;
let fetchCalls = [];
let responseMode = "success";
let nativeFolders = [];
let savedMessages = [];
let nativeActions = [];
let upload = null;
let streamingVideo = true;
let pageBundle = null;
let publicPayload = {};
let revealSaved = true;
let revealedPaths = [];
let clearedNotifications = [];
let revealError = "";
let notificationCount = 0;
let gifConversion = true;

globalThis.chrome = {
  runtime: {
    id: extensionId, getURL: name => origin + name,
    onInstalled: hook(), onStartup: hook(), onMessage: hook(),
    openOptionsPage: async () => {},
    connectNative() {
      const port = { onMessage: hook(), onDisconnect: hook() };
      launches++;
      if (missingHost) {
        port.postMessage = () => {};
        port.disconnect = () => {};
        queueMicrotask(() => {
          chrome.runtime.lastError = { message: "Specified native messaging host not found." };
          port.onDisconnect.fire();
          delete chrome.runtime.lastError;
        });
        return port;
      }
      // Chrome transport is mocked here; native_test.py separately runs the actual binary.
      port.postMessage = value => {
        let response;
        nativeActions.push(value.action);
        if (value.action === "ping") response = { ok: true, streamingVideo, revealSaved, gifConversion, folders: structuredClone(nativeFolders) };
        else if (value.action === "configure") { nativeFolders = structuredClone(value.folders); response = { ok: true, folders: nativeFolders }; }
        else if (value.action === "save") {
          savedMessages.push(structuredClone(value));
          response = { ok: true, filename: value.filename, path: destination + "\\" + value.filename };
        }
        else if (value.action === "beginSave") { upload = { ...value, chunks: [] }; response = { ok: true }; }
        else if (value.action === "saveChunk") { savedMessages.push(structuredClone(value)); upload.chunks.push(Buffer.from(value.base64, "base64")); response = { ok: true }; }
        else if (value.action === "endSave") {
          const filename = upload.convertToGif ? upload.filename.replace(/\.mp4$/, ".gif") : upload.filename;
          response = { ok: true, filename, path: destination + "\\" + filename, bytes: Buffer.concat(upload.chunks).length };
        }
        else if (value.action === "cancelSave") { upload = null; response = { ok: true }; }
        else if (value.action === "revealSaved") { revealedPaths.push(value.path); response = revealError ? { ok: false, error: revealError } : { ok: true }; }
        queueMicrotask(() => port.onMessage.fire(response));
      };
      port.disconnect = () => port.onDisconnect.fire();
      return port;
    }
  },
  storage: { local: {
    async get(keys) {
      if (typeof keys === "string") return { [keys]: structuredClone(store[keys]) };
      return Object.fromEntries(keys.map(key => [key, structuredClone(store[key])]));
    },
    async set(values) { Object.assign(store, structuredClone(values)); }
  } },
  contextMenus: { onClicked: hook(), async removeAll() { menus = []; }, create(item, callback) { menus.push(item); queueMicrotask(callback); return item.id; } },
  action: { onClicked: hook() },
  tabs: { async sendMessage() { return pageBundle; } },
  notifications: {
    onClicked: hook(),
    async create(idOrOptions, options) {
      const id = typeof idOrOptions === "string" ? idOrOptions : `auto:${++notificationCount}`;
      notifications.push({ ...(options || idOrOptions), id }); return id;
    },
    async clear(id) { clearedNotifications.push(id); return true; }
  }
};
globalThis.fetch = async url => {
  fetchCalls.push(url);
  if (new URL(url).hostname === "cdn.syndication.twimg.com") {
    const response = new Response(JSON.stringify(publicPayload)); Object.defineProperty(response, "url", { value: url }); return response;
  }
  if (new URL(url).hostname === "video.twimg.com") {
    const content = responseMode === "html" ? Buffer.from("<html>error</html>") : MP4;
    const body = new ReadableStream({
      start(controller) {
        if (responseMode === "interrupted") {
          controller.enqueue(content.subarray(0, 5000));
          this.failed = false;
        } else {
          // Deliberately split the ftyp box across network boundaries.
          controller.enqueue(content.subarray(0, 3)); controller.enqueue(content.subarray(3, 9));
          controller.enqueue(content.subarray(9)); controller.close();
        }
      },
      pull(controller) { if (responseMode === "interrupted") controller.error(new TypeError("connection reset")); }
    });
    const response = new Response(body, { headers: {
      "content-type": "video/mp4",
      "content-length": responseMode === "oversized" ? String(513 * 1024 * 1024) : responseMode === "incomplete" ? String(MP4.length + 5) : String(content.length)
    } });
    Object.defineProperty(response, "url", { value: responseMode === "redirect" ? "https://evil.test/file.mp4" : url }); return response;
  }
  const status = responseMode === "fallback" && new URL(url).searchParams.get("name") === "orig" ? 404 : 200;
  const content = responseMode === "html" ? Buffer.from("<html>Error</html>") : PNG;
  const response = new Response(content, { status, headers: { "content-type": "image/png" } });
  Object.defineProperty(response, "url", { value: url });
  return response;
};
await import("../extension/background.js");

const waitFor = async predicate => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for background operation");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const settingsRequest = message => new Promise(resolve => {
  chrome.runtime.onMessage.listeners[0](message, { id: extensionId, url: origin + "options.html" }, resolve);
});
const click = () => chrome.contextMenus.onClicked.fire({
  menuItemId: `folder:${folder.id}`, pageUrl: "https://x.com/test/status/123",
  srcUrl: "https://pbs.twimg.com/media/abc?format=png&name=small"
});

beforeEach(() => {
  store = { folders: [folder], preferOriginal: true }; menus = []; notifications = []; missingHost = false; launches = 0; fetchCalls = []; responseMode = "success";
  nativeFolders = [folder]; savedMessages = [];
  pageBundle = null; publicPayload = {}; streamingVideo = true; nativeActions = []; upload = null;
  revealSaved = true; revealedPaths = []; clearedNotifications = []; revealError = ""; notificationCount = 0;
  gifConversion = true;
});
test("图片、视频与覆盖层可用右键菜单，图片内容正确发送到选定目录", async () => {
  chrome.runtime.onInstalled.fire();
  await waitFor(() => menus.some(item => item.id === "settings"));
  assert.deepEqual(menus.find(item => item.id === `folder:${folder.id}`).contexts, ["image", "video", "page"]);
  click(); await waitFor(() => notifications.length === 1);
  assert.equal(store.recent[0].ok, true);
  assert.deepEqual(Buffer.from(savedMessages[0].base64, "base64"), PNG);
  assert.equal(savedMessages[0].folderId, folder.id);
  assert.equal(store.recent[0].folder, "插画");
  assert.match(fetchCalls[0], /name=orig/);
});

test("原图请求失败时保存显示图，并标记回退", async () => {
  responseMode = "fallback";
  click(); await waitFor(() => notifications.length === 1);
  assert.equal(fetchCalls.length, 2);
  assert.equal(store.recent[0].fallback, true);
  assert.equal(store.recent[0].ok, true);
});

test("服务器错误页不能写入目标目录，失败结果可见", async () => {
  responseMode = "html";
  click(); await waitFor(() => notifications.length === 1);
  assert.equal(store.recent[0].ok, false);
  assert.equal(savedMessages.length, 0);
  assert.match(store.recent[0].error, /可识别的图片/);
});

test("未安装本机助手时，在下载前给出安装提示", async () => {
  missingHost = true;
  click(); await waitFor(() => notifications.length === 1);
  assert.equal(fetchCalls.length, 0);
  assert.equal(store.recent[0].ok, false);
  assert.match(store.recent[0].error, /install.cmd/);
});

test("设置保存完成后，重新生成菜单并保留原图偏好", async () => {
  const updated = { ...folder, name: "参考图" };
  const response = await settingsRequest({ action: "configure", folders: [updated], preferOriginal: false });
  assert.equal(response.ok, true, response.error);
  assert.equal(menus.find(item => item.id === `folder:${folder.id}`).title, "参考图");
  assert.equal(store.preferOriginal, false);
  assert.equal(store.convertGifs, true);
  assert.equal(nativeFolders[0].name, "参考图");
});

test("网页和其他扩展不能修改目录或打开文件夹选择器", () => {
  let reply = false;
  const accepted = chrome.runtime.onMessage.listeners[0]({ action: "pickDirectory" }, { id: extensionId, url: "https://x.com/" }, () => { reply = true; });
  assert.equal(accepted, false); assert.equal(launches, 0); assert.equal(reply, false);
});

function videoClick(srcUrl = "blob:https://x.com/temporary") {
  chrome.contextMenus.onClicked.fire({ menuItemId: `folder:${folder.id}`, pageUrl: "https://x.com/test/status/123", mediaType: "video", srcUrl }, { id: 1 });
}
function videoBundle(type = "video") {
  return { context: { kind: "video", tweetId: "123", poster }, media: { type, poster, variants: [{ url: videoLow, bitrate: 100 }, { url: videoHigh, bitrate: 200 }] } };
}
const done = () => waitFor(() => Boolean(store.recent?.length) && !["开始保存视频", "开始保存动图", "正在生成 GIF"].includes(notifications.at(-1)?.title));
test("blob 视频根据页面元数据选择最高码率，分块传输且字节一致", async () => {
  pageBundle = videoBundle(); videoClick(); await done();
  assert.equal(store.recent[0].ok, true, store.recent[0].error);
  assert.equal(fetchCalls[0], videoHigh);
  assert.deepEqual(Buffer.concat(savedMessages.map(item => Buffer.from(item.base64, "base64"))), MP4);
  assert.ok(savedMessages.every(item => Buffer.from(item.base64, "base64").length <= 256 * 1024));
  assert.deepEqual(savedMessages.map(item => item.sequence), [0, 1]);
  assert.equal(store.recent[0].bytes, MP4.length);
  assert.equal(upload.folderId, folder.id);
});
test("播放器覆盖层没有 srcUrl 也能保存动图，默认要求生成真正 GIF", async () => {
  pageBundle = videoBundle("animated_gif");
  chrome.contextMenus.onClicked.fire({ menuItemId: `folder:${folder.id}`, pageUrl: "https://x.com/home" }, { id: 1 });
  await done(); assert.equal(store.recent[0].ok, true); assert.equal(store.recent[0].mediaType, "animated_gif");
  assert.match(store.recent[0].filename, /\.gif$/);
  assert.equal(upload.convertToGif, true);
  const finish = notifications.find(item => item.title.startsWith("已保存到"));
  chrome.notifications.onClicked.fire(finish.id);
  await waitFor(() => clearedNotifications.length === 1);
  assert.match(revealedPaths[0], /\.gif$/);
});
test("关闭动图转 GIF 后仍按原始 MP4 保存，普通视频保持 MP4", async () => {
  const response = await settingsRequest({ action: "configure", folders: [folder], convertGifs: false });
  assert.equal(response.ok, true); assert.equal(store.convertGifs, false);
  pageBundle = videoBundle("animated_gif"); videoClick(); await done();
  assert.equal(store.recent[0].ok, true); assert.equal(upload.convertToGif, false);
  assert.match(store.recent[0].filename, /\.mp4$/);
  store.convertGifs = true; store.recent = []; notifications = [];
  pageBundle = videoBundle(); videoClick(); await done();
  assert.equal(upload.convertToGif, false); assert.match(store.recent[0].filename, /\.mp4$/);
});
test("GIF 标签、专用封面或地址也可补充动图识别", async () => {
  for (const hint of ["label", "poster", "url"]) {
    pageBundle = videoBundle(); store.recent = []; notifications = [];
    if (hint === "label") pageBundle.context.animatedGif = true;
    if (hint === "poster") pageBundle.context.poster = "https://pbs.twimg.com/tweet_video_thumb/example.jpg";
    if (hint === "url") pageBundle.media.variants = [{ url: "https://video.twimg.com/tweet_video/example.mp4" }];
    videoClick(); await done();
    assert.equal(store.recent[0].ok, true, hint); assert.equal(upload.convertToGif, true, hint);
  }
});
test("助手缺少 GIF 转换功能时提示升级，不悄悄保存为视频", async () => {
  gifConversion = false; pageBundle = videoBundle("animated_gif"); videoClick(); await done();
  assert.equal(store.recent[0].ok, false); assert.equal(fetchCalls.length, 0);
  assert.ok(!nativeActions.includes("beginSave")); assert.match(store.recent[0].error, /新版.*install.cmd/);
});
test("公开嵌入接口可以补充地址，多媒体推文按点击的封面选择", async () => {
  publicPayload = { id_str: "123", mediaDetails: [
    { type: "video", media_url_https: poster.replace("sample", "wrong"), video_info: { variants: [{ url: videoLow }] } },
    { type: "video", media_url_https: poster, video_info: { variants: [{ url: videoHigh }] } }
  ] };
  pageBundle = { context: { kind: "video", tweetId: "123", poster }, media: null };
  videoClick(); await done(); assert.equal(store.recent[0].ok, true); assert.equal(fetchCalls[1], videoHigh);
  assert.match(fetchCalls[0], /cdn\.syndication\.twimg\.com\/tweet-result/);
});
test("旧助手给出升级提示，不开始下载视频", async () => {
  streamingVideo = false; pageBundle = videoBundle(); videoClick(); await done();
  assert.equal(fetchCalls.length, 0); assert.match(store.recent[0].error, /新版.*install.cmd/);
});
test("视频错误页、外站重定向和超大文件不会开始落盘", async () => {
  for (const mode of ["html", "redirect", "oversized"]) {
    responseMode = mode; pageBundle = videoBundle(); store.recent = []; nativeActions = []; notifications = [];
    videoClick(); await done(); assert.equal(store.recent[0].ok, false, mode);
    assert.ok(!nativeActions.includes("beginSave"), mode);
  }
});
test("网络中断或 Content-Length 不完整时取消传输，不提交最终文件", async () => {
  for (const mode of ["interrupted", "incomplete"]) {
    responseMode = mode; pageBundle = videoBundle(); store.recent = []; nativeActions = []; notifications = [];
    videoClick(); await done(); assert.equal(store.recent[0].ok, false, mode);
    assert.ok(!nativeActions.includes("endSave"), mode);
    assert.ok(nativeActions.includes("cancelSave"), mode);
  }
});
test("找不到 MP4 地址时明确失败，不保存封面或 HLS 播放列表", async () => {
  pageBundle = { context: { kind: "video", poster, tweetId: "123" }, media: null };
  videoClick(); await done(); assert.equal(store.recent[0].ok, false); assert.match(store.recent[0].error, /MP4.*刷新/);
  assert.ok(!nativeActions.includes("beginSave"));
});

test("点击图片完成通知打开该文件位置，目标在显示通知前持久保存", async () => {
  click(); await waitFor(() => notifications.length === 1);
  const toast = notifications[0];
  assert.match(toast.message, /点击打开文件夹/);
  assert.equal(store.notificationTargets[0].id, toast.id);
  chrome.notifications.onClicked.fire(toast.id);
  await waitFor(() => clearedNotifications.length === 1);
  assert.deepEqual(revealedPaths, [store.recent[0].path]);
  assert.equal(clearedNotifications[0], toast.id);
});
test("视频开始通知不会打开目录，完成通知会定位视频", async () => {
  pageBundle = videoBundle(); videoClick(); await done();
  const start = notifications.find(item => item.title === "开始保存视频");
  const finish = notifications.find(item => item.title.startsWith("已保存到"));
  chrome.notifications.onClicked.fire(start.id);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(revealedPaths.length, 0);
  chrome.notifications.onClicked.fire(finish.id);
  await waitFor(() => clearedNotifications.length === 1);
  assert.match(revealedPaths[0], /high\.mp4$/);
});
test("多次下载的通知分别定位各自文件，不使用最新下载路径替代", async () => {
  click(); await waitFor(() => notifications.length === 1);
  const first = notifications[0]; const firstPath = store.recent[0].path;
  chrome.contextMenus.onClicked.fire({ menuItemId: `folder:${folder.id}`, pageUrl: "https://x.com/test/status/123", srcUrl: "https://pbs.twimg.com/media/second?format=png" });
  await waitFor(() => notifications.length === 2);
  const second = notifications[1]; const secondPath = store.recent[0].path;
  assert.notEqual(firstPath, secondPath);
  chrome.notifications.onClicked.fire(first.id); await waitFor(() => clearedNotifications.length === 1);
  chrome.notifications.onClicked.fire(second.id); await waitFor(() => clearedNotifications.length === 2);
  assert.deepEqual(revealedPaths, [firstPath, secondPath]);
});
test("通知目标可从本地存储恢复，不依赖最近十条或内存，未知通知不启动助手", async () => {
  store.notificationTargets = [{ id: "x-saved:from-previous-worker", path: destination + "\\older.gif" }];
  store.recent = [];
  chrome.notifications.onClicked.fire("x-saved:unknown");
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(launches, 0);
  chrome.notifications.onClicked.fire("x-saved:from-previous-worker");
  await waitFor(() => clearedNotifications.length === 1);
  assert.deepEqual(revealedPaths, [destination + "\\older.gif"]);
});
test("失败通知不打开目录，旧助手点击时给升级提示且不改保存结果", async () => {
  responseMode = "html"; click(); await waitFor(() => notifications.length === 1);
  const failed = notifications[0]; const previousLaunches = launches;
  chrome.notifications.onClicked.fire(failed.id);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(launches, previousLaunches);
  responseMode = "success"; revealSaved = false; click(); await waitFor(() => notifications.length === 2);
  chrome.notifications.onClicked.fire(notifications[1].id);
  await waitFor(() => notifications.length === 3);
  assert.match(notifications[2].message, /新版 install.cmd/);
  assert.equal(store.recent[0].ok, true);
  assert.equal(revealedPaths.length, 0);
});
test("打开目录失败仅提示定位错误，保留下载成功记录", async () => {
  click(); await waitFor(() => notifications.length === 1);
  revealError = "保存目录不存在或当前无法访问。";
  chrome.notifications.onClicked.fire(notifications[0].id);
  await waitFor(() => notifications.length === 2);
  assert.equal(store.recent.length, 1); assert.equal(store.recent[0].ok, true);
  assert.equal(notifications[1].title, "文件已保存，目录未能打开");
});
