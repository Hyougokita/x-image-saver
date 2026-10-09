import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = name => readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");
const metadata = { data: { result: { rest_id: "123", private_text: "must not be sent", legacy: { extended_entities: { media: [{ type: "animated_gif", media_url_https: "https://pbs.twimg.com/tweet_video_thumb/abc.jpg", video_info: { variants: [{ bitrate: 100, url: "https://video.twimg.com/tweet_video/abc.mp4" }] } }] } } } } };
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("page observation timeout"); };
function observer(poisonNamespace = false) {
  const messages = [];
  let calls = [];
  class XHR {
    open(...args) { this.openArgs = args; }
    send(...args) { this.sendArgs = args; }
    addEventListener(name, fn) { this.listener = fn; }
  }
  const window = { fetch: async (...args) => { calls.push(args); return new Response(JSON.stringify(metadata), { headers: { "content-type": "application/json" } }); }, postMessage: (data, target) => messages.push({ data, target }) };
  const context = vm.createContext({ window, location: { origin: "https://x.com", href: "https://x.com/home" }, XMLHttpRequest: XHR, URL, TextDecoder, Uint8Array });
  if (poisonNamespace) Object.defineProperty(context, "XImageSaverMedia", { get() { throw new Error("Unexpected global helper dependency"); } });
  vm.runInContext(source("page-observer.js"), context);
  return { window, XHR, messages, calls };
}
test("fetch 观察不消耗页面响应、不改请求参数，只发出媒体信息", async () => {
  const { window, messages, calls } = observer();
  const options = { headers: { secret: "not sent" }, credentials: "include" };
  const response = await window.fetch("https://x.com/i/api/graphql/query/Home", options);
  assert.deepEqual(await response.json(), metadata);
  await waitFor(() => messages.length === 1);
  assert.equal(calls[0][1], options);
  assert.equal(messages[0].target, "https://x.com");
  assert.equal(messages[0].data.items[0].type, "animated_gif");
  assert.doesNotMatch(JSON.stringify(messages), /must not be sent|secret|not sent/);
});
test("XHR 的 JSON 和文本响应都可识别，非 X API 请求不被观察", async () => {
  const { window, XHR, messages } = observer();
  await window.fetch("https://example.org/json");
  const request = new XHR(); request.open("GET", "/i/api/graphql/query/Detail"); request.send();
  request.status = 200; request.responseType = "json"; request.response = metadata; request.listener();
  assert.equal(messages.length, 1);
  const second = new XHR(); second.open("GET", "/i/api/other"); second.send();
  second.status = 200; second.responseType = ""; second.responseText = JSON.stringify(metadata); second.listener();
  assert.equal(messages.length, 2);
});
test("隔离脚本记录右键视频覆盖层的封面，并拒绝外部消息和错误扩展", () => {
  let messageListener, clickListener, requestListener;
  class Element {
    closest(selector) {
      if (selector.includes("videoPlayer")) return { querySelectorAll: () => [], querySelector: name => name === "video" ? { currentSrc: "blob:https://x.com/abc", poster: "https://pbs.twimg.com/tweet_video_thumb/abc.jpg" } : null };
      if (selector === "article") return { querySelector: () => ({ closest: () => ({ href: "https://x.com/test/status/123" }) }) };
      return null;
    }
  }
  const window = { addEventListener: (type, fn) => { if (type === "message") messageListener = fn; else if (type === "contextmenu") clickListener = fn; } };
  const chrome = { runtime: { id: "extension", onMessage: { addListener: fn => { requestListener = fn; } } } };
  const context = vm.createContext({ window, chrome, Element, URL, location: { origin: "https://x.com", href: "https://x.com/home" }, Date });
  vm.runInContext(source("content.js"), context);
  const items = JSON.parse(JSON.stringify(metadata.data.result.legacy.extended_entities.media)).map(item => ({ poster: item.media_url_https, type: item.type, tweetId: "123", variants: item.video_info.variants }));
  const event = { source: {}, origin: "https://evil.test", data: { source: "x-image-saver-media-v2", items } };
  messageListener(event); clickListener({ target: new Element(), stopImmediatePropagation() {} });
  let reply; requestListener({ action: "resolveMedia" }, { id: "extension" }, r => { reply = r; });
  assert.equal(reply.media, null);
  messageListener({ ...event, source: window, origin: "https://x.com" });
  requestListener({ action: "resolveMedia" }, { id: "extension" }, r => { reply = r; });
  assert.equal(reply.context.kind, "video"); assert.equal(reply.context.tweetId, "123");
  assert.equal(reply.media.type, "animated_gif");
  assert.equal(requestListener({ action: "resolveMedia" }, { id: "other" }, () => assert.fail()), false);
});

function menuFixture(poisonNamespace = false) {
  const listeners = new Map();
  let requestListener;
  const window = { addEventListener(type, fn, capture) {
    const list = listeners.get(type) || [];
    list.push({ fn, capture }); listeners.set(type, list);
  } };
  class Element {
    constructor(kind) { this.kind = kind; }
    closest(selector) {
      if (selector.includes("videoPlayer") && this.kind === "overlay") return { querySelectorAll: () => [], querySelector: name => name === "video" ? { currentSrc: "blob:https://x.com/video", poster: "https://pbs.twimg.com/tweet_video_thumb/abc.jpg" } : null };
      if (selector === "video" && this.kind === "video") return { currentSrc: "blob:https://x.com/video", poster: "https://pbs.twimg.com/tweet_video_thumb/abc.jpg" };
      if (selector === "img" && this.kind === "image") return { currentSrc: "https://pbs.twimg.com/media/picture.jpg", src: "https://pbs.twimg.com/media/picture.jpg" };
      return null;
    }
  }
  const chrome = { runtime: { id: "extension", onMessage: { addListener: fn => { requestListener = fn; } } } };
  const context = vm.createContext({ window, Element, chrome, URL, Date, location: { origin: "https://x.com", href: "https://x.com/test/status/123" } });
  if (poisonNamespace) Object.defineProperty(context, "XImageSaverMedia", { get() { throw new Error("Unexpected global helper dependency"); } });
  vm.runInContext(source("content.js"), context);
  let siteMenu = false;
  // Model the site's later handler: it both shows its menu and cancels Chrome's default.
  window.addEventListener("contextmenu", event => { siteMenu = true; event.preventDefault(); }, true);
  function rightClick(kind, shiftKey = false) {
    siteMenu = false;
    const event = { target: new Element(kind), shiftKey, defaultPrevented: false, immediateStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.immediateStopped = true; } };
    for (const listener of listeners.get("contextmenu")) {
      assert.equal(listener.capture, true);
      listener.fn(event); if (event.immediateStopped) break;
    }
    let reply; requestListener({ action: "resolveMedia" }, { id: "extension" }, value => { reply = value; });
    return { event, siteMenu, reply };
  }
  function receive(data) {
    for (const listener of listeners.get("message")) listener.fn({ source: window, origin: "https://x.com", data });
  }
  return { rightClick, receive };
}
test("视频与覆盖层右键阻止站点菜单，但保留浏览器默认菜单和媒体目标", () => {
  const { rightClick } = menuFixture();
  for (const kind of ["video", "overlay"]) {
    const { event, siteMenu, reply } = rightClick(kind);
    assert.equal(event.immediateStopped, true);
    assert.equal(event.defaultPrevented, false);
    assert.equal(siteMenu, false);
    assert.equal(reply.context.kind, "video");
    assert.equal(reply.context.tweetId, "123");
    assert.equal(reply.context.srcUrl, "blob:https://x.com/video");
  }
});
test("Shift 加右键仍允许推特原生菜单运行", () => {
  const { event, siteMenu, reply } = menuFixture().rightClick("video", true);
  assert.equal(event.immediateStopped, false);
  assert.equal(siteMenu, true);
  assert.equal(event.defaultPrevented, true);
  assert.equal(reply.context.kind, "video");
});
test("普通图片和页面的右键事件继续传播，不改变其他内容的菜单行为", () => {
  const { rightClick } = menuFixture();
  for (const kind of ["image", "page"]) {
    const { event, siteMenu, reply } = rightClick(kind);
    assert.equal(event.immediateStopped, false);
    assert.equal(siteMenu, true);
    assert.equal(reply.context.kind, kind);
  }
});

test("content.js 独立启动且忽略不存在或被覆盖的共享对象，视频右键仍正常", () => {
  const { event, reply } = menuFixture(true).rightClick("video");
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.immediateStopped, true);
  assert.equal(reply.context.animatedGif, true);
  assert.equal(reply.context.srcUrl, "blob:https://x.com/video");
});

test("page-observer.js 独立识别 GIF，不读取页面上的共享对象", async () => {
  const { window, messages } = observer(true);
  const response = await window.fetch("https://x.com/i/api/graphql/query/Detail");
  assert.deepEqual(await response.json(), metadata);
  await waitFor(() => messages.length === 1);
  assert.equal(messages[0].data.items[0].type, "animated_gif");
  assert.match(messages[0].data.items[0].variants[0].url, /tweet_video\/abc\.mp4/);
});

test("两个独立执行环境通过消息传递 GIF 元数据，不共享 JavaScript 全局对象", async () => {
  const observed = observer(true);
  const isolated = menuFixture(true);
  await observed.window.fetch("https://x.com/i/api/graphql/query/Detail");
  await waitFor(() => observed.messages.length === 1);
  isolated.receive(observed.messages[0].data);
  const { reply } = isolated.rightClick("overlay");
  assert.equal(reply.media.type, "animated_gif");
  assert.equal(reply.media.tweetId, "123");
  assert.match(reply.media.variants[0].url, /tweet_video\/abc\.mp4/);
});

test("清单为两个执行环境各加载一个完整脚本，不要求额外先加载共享库", () => {
  const manifest = JSON.parse(source("manifest.json"));
  const isolated = manifest.content_scripts.find(entry => entry.world === "ISOLATED");
  const main = manifest.content_scripts.find(entry => entry.world === "MAIN");
  assert.deepEqual(isolated.js, ["content.js"]);
  assert.deepEqual(main.js, ["page-observer.js"]);
  for (const entry of [isolated, main]) {
    assert.equal(entry.run_at, "document_start");
    assert.doesNotThrow(() => new vm.Script(source(entry.js[0])));
  }
});
