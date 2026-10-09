import {
  HOST_NAME, MAX_IMAGE_BYTES, DOCUMENT_PATTERNS, isAllowedPage,
  imageUrls, imageFormat, imageFilename, bytesToBase64, validateFolders
} from "./core.js";
import { videoUrl, variantsOf, collectMedia, selectMedia, mp4Format } from "./media-core.js";
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

class NativeSession {
  constructor() {
    this.closed = false;
    this.pending = null;
    this.port = chrome.runtime.connectNative(HOST_NAME);
    this.port.onMessage.addListener(message => {
      if (!this.pending) return;
      const { resolve, reject, timer } = this.pending;
      clearTimeout(timer);
      this.pending = null;
      if (message.ok) resolve(message);
      else reject(new Error(message.error || "本机助手未能完成操作。"));
    });
    this.port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message;
      this.closed = true;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error(detail
          ? "无法连接本机助手。请先双击 install.cmd 安装，再重新检测连接。"
          : "本机助手连接已中断，请重试。"));
        this.pending = null;
      }
    });
  }
  request(message, timeout = 90000) {
    if (this.closed) return Promise.reject(new Error("本机助手未连接，请运行 install.cmd 后重试。"));
    if (this.pending) return Promise.reject(new Error("上一项操作还没有完成。"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error("操作等待时间过长，请重试。"));
        this.close();
      }, timeout);
      this.pending = { resolve, reject, timer };
      try { this.port.postMessage(message); }
      catch (error) { clearTimeout(timer); this.pending = null; reject(error); }
    });
  }
  close() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("操作已结束。"));
      this.pending = null;
    }
    if (!this.closed) { this.closed = true; this.port.disconnect(); }
  }
}

async function nativeRequest(message, timeout) {
  const session = new NativeSession();
  try { return await session.request(message, timeout); }
  finally { session.close(); }
}

let menuQueue = Promise.resolve();
function createMenu(properties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(properties, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
function rebuildMenus() {
  menuQueue = menuQueue.catch(() => {}).then(async () => {
    const { folders = [] } = await chrome.storage.local.get("folders");
    await chrome.contextMenus.removeAll();
    const scope = { contexts: ["image", "video", "page"], documentUrlPatterns: DOCUMENT_PATTERNS };
    await createMenu({ ...scope, id: "x-save", title: "媒体存档 · 保存到" });
    if (!folders.length) {
      await createMenu({ ...scope, id: "empty", parentId: "x-save", title: "请先添加保存文件夹", enabled: false });
    }
    for (const folder of folders) {
      await createMenu({ ...scope, id: `folder:${folder.id}`, parentId: "x-save", title: folder.name });
    }
    await createMenu({ ...scope, id: "separator", parentId: "x-save", type: "separator" });
    await createMenu({ ...scope, id: "settings", parentId: "x-save", title: "管理保存文件夹…" });
  });
  return menuQueue;
}

async function syncFolders(folders) {
  await chrome.storage.local.set({ folders: validateFolders(folders) });
  await rebuildMenus();
}

async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, { credentials: "omit", signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）。`);
    // Validate the redirect target as well as the initial URL.
    imageUrls(response.url, false);
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("图片超过 20 MB，目前不支持保存。");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new Error("图片超过 20 MB，目前不支持保存。"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, format: imageFormat(bytes), source: response.url };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("下载超时，请检查网络或浏览器代理后重试。");
    if (error instanceof TypeError) throw new Error("无法下载图片，请检查网络或浏览器代理后重试。");
    throw error;
  } finally { clearTimeout(timer); }
}

let historyQueue = Promise.resolve();
async function reportResult(result) {
  const notificationId = result.ok ? `x-saved:${crypto.randomUUID()}` : undefined;
  historyQueue = historyQueue.catch(() => {}).then(async () => {
    const { recent = [], notificationTargets = [] } = await chrome.storage.local.get(["recent", "notificationTargets"]);
    const time = new Date().toISOString();
    const state = { recent: [{ ...result, time }, ...recent].slice(0, 10) };
    // Persist before showing the toast: a click may wake a fresh service worker.
    if (notificationId && result.path) state.notificationTargets = [{ id: notificationId, path: result.path, time }, ...notificationTargets].slice(0, 200);
    await chrome.storage.local.set(state);
  });
  await historyQueue;
  try {
    const options = {
      type: "basic", iconUrl: "icons/icon128.png",
      title: result.ok ? `已保存到「${result.folder}」` : "媒体未能保存",
      message: result.ok ? `${result.filename}${result.fallback ? "（原图不可用，已保存当前尺寸）" : ""}\n点击打开文件夹` : result.error
    };
    if (notificationId) await chrome.notifications.create(notificationId, options);
    else await chrome.notifications.create(options);
  } catch { /* The settings page still shows results if OS notifications are disabled. */ }
}

async function openNotificationLocation(notificationId) {
  if (!notificationId.startsWith("x-saved:")) return;
  let session;
  try {
    const { notificationTargets = [] } = await chrome.storage.local.get("notificationTargets");
    const target = notificationTargets.find(item => item.id === notificationId);
    if (!target?.path) return;
    session = new NativeSession();
    const state = await session.request({ action: "ping" });
    if (!state.revealSaved) throw new Error("点击通知打开文件夹需要升级本机助手。请运行新版 install.cmd；已下载的文件不受影响。");
    await session.request({ action: "revealSaved", path: target.path });
    await chrome.notifications.clear(notificationId);
  } catch (error) {
    try {
      await chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "文件已保存，目录未能打开", message: error.message || "无法打开保存目录，请在设置页查看文件位置。" });
    } catch { }
  } finally { session?.close(); }
}

chrome.notifications.onClicked.addListener(notificationId => { void openNotificationLocation(notificationId); });

async function pageMedia(info, tab) {
  if (!tab?.id) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { action: "resolveMedia" }, { frameId: info.frameId || 0 }); }
  catch { return null; /* An old page must be refreshed to receive the new content script. */ }
}

async function publicMedia(tweetId) {
  if (!/^\d{1,22}$/.test(tweetId)) return [];
  const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
  url.searchParams.set("id", tweetId);
  url.searchParams.set("lang", "en");
  url.searchParams.set("token", ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/[0.]/g, ""));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.href, { credentials: "omit", signal: controller.signal });
    const final = new URL(response.url);
    if (!response.ok || final.origin !== url.origin || final.pathname !== url.pathname) return [];
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); return []; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return collectMedia(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return []; }
  finally { clearTimeout(timer); }
}

async function resolveVideo(info, bundle) {
  const context = { ...(bundle?.context || {}), srcUrl: info.srcUrl || bundle?.context?.srcUrl || "" };
  if (!context.tweetId) context.tweetId = (info.pageUrl || "").match(/\/status\/(\d+)/)?.[1] || "";
  if (!context.poster && /^https:\/\/pbs\.twimg\.com\//.test(context.srcUrl)) context.poster = context.srcUrl;
  let media = bundle?.media;
  let variants = variantsOf(media?.variants);
  if (!variants.length) {
    media = selectMedia(await publicMedia(context.tweetId), context);
    variants = variantsOf(media?.variants);
  }
  if (!variants.length) {
    try { variants = [{ url: videoUrl(context.srcUrl) }]; } catch { }
  }
  if (!variants.length) throw new Error("尚未找到这个视频的 MP4 地址。请刷新推文、播放一下视频后再右键保存；直播、仅 HLS 的视频和站外视频暂不支持。");
  const animated = media?.type === "animated_gif" || context.animatedGif === true ||
    /\/tweet_video_thumb\//.test(context.poster || "") || /\/tweet_video\//.test(variants[0].url);
  return { url: variants[0].url, type: animated ? "animated_gif" : "video", tweetId: context.tweetId };
}

async function streamVideo(url, filename, folder, session, convertToGif = false) {
  videoUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
  let reader;
  let begun = false;
  let complete = false;
  let headerTimer;
  try {
    headerTimer = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(url, { credentials: "omit", signal: controller.signal, cache: "no-store" });
    clearTimeout(headerTimer);
    if (!response.ok) throw new Error(`视频请求失败（HTTP ${response.status}）。请重新打开推文再试。`);
    videoUrl(response.url);
    if (Number(response.headers.get("content-length")) > MAX_VIDEO_BYTES) throw new Error("视频超过 512 MB，暂不支持保存。");
    reader = response.body.getReader();
    let size = 0;
    let sequence = 0;
    const read = async () => {
      const idle = setTimeout(() => controller.abort(), 60000);
      try { return await reader.read(); } finally { clearTimeout(idle); }
    };
    const send = async bytes => {
      size += bytes.length;
      if (size > MAX_VIDEO_BYTES) throw new Error("视频超过 512 MB，暂不支持保存。");
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        await session.request({ action: "saveChunk", sequence: sequence++, base64: bytesToBase64(bytes.subarray(offset, offset + CHUNK_BYTES)) });
      }
    };
    // Network chunks can split the MP4 header at any byte boundary.
    const prefix = [];
    let prefixSize = 0;
    let ended = false;
    while (prefixSize < 4096) {
      const chunk = await read();
      if (chunk.done) { ended = true; break; }
      prefix.push(chunk.value); prefixSize += chunk.value.length;
    }
    const first = new Uint8Array(prefixSize);
    let offset = 0;
    for (const chunk of prefix) { first.set(chunk, offset); offset += chunk.length; }
    mp4Format(first);
    await session.request({ action: "beginSave", folderId: folder.id, filename, convertToGif });
    begun = true;
    await send(first);
    while (!ended) {
      const { done, value } = await read();
      if (done) break;
      await send(value);
    }
    const length = Number(response.headers.get("content-length"));
    if (length > 0 && !response.headers.get("content-encoding") && size !== length) throw new Error("视频下载不完整，请重新保存。");
    if (convertToGif) {
      try { await chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: "正在生成 GIF", message: "动图下载完成，正在转换为可循环播放的 GIF。完成后会通知你。" }); } catch { }
    }
    const result = await session.request({ action: "endSave" }, convertToGif ? 660000 : 90000);
    complete = true;
    return result;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("视频下载超时，请检查浏览器网络或代理后重试。");
    if (error instanceof TypeError) throw new Error("视频下载中断，请检查浏览器网络或代理后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(headerTimer);
    if (!complete) controller.abort();
    if (reader) { if (!complete) { try { await reader.cancel(); } catch { } } reader.releaseLock(); }
    if (begun && !complete) { try { await session.request({ action: "cancelSave" }, 5000); } catch { } }
  }
}

async function saveMedia(info, tab) {
  let session;
  try {
    if (!isAllowedPage(info.frameUrl || info.pageUrl)) throw new Error("请在 X / Twitter 页面上右键图片、动图或视频。");
    const bundle = await pageMedia(info, tab);
    const source = info.srcUrl || bundle?.context?.srcUrl || "";
    const video = info.mediaType === "video" || bundle?.context?.kind === "video" || Boolean(bundle?.media) ||
      /^https:\/\/video\.twimg\.com\//.test(source) ||
      /\/(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(source);
    if (!video && !source) throw new Error("没有选中媒体。请在图片或视频画面上右键；升级后请先刷新 X 页面。");
    session = new NativeSession();
    const state = await session.request({ action: "ping" });
    const folder = state.folders.find(item => `folder:${item.id}` === info.menuItemId);
    if (!folder) { await syncFolders(state.folders); throw new Error("这个保存目录已被修改，请重新打开右键菜单选择。"); }
    if (video) {
      if (!state.streamingVideo) throw new Error("本机助手需要升级。请运行新版安装包中的 install.cmd，再重试。");
      const media = await resolveVideo(info, bundle);
      const { convertGifs = true } = await chrome.storage.local.get("convertGifs");
      const convertToGif = media.type === "animated_gif" && convertGifs;
      if (convertToGif && !state.gifConversion) throw new Error("保存真正的 GIF 需要升级本机助手。请运行新版 install.cmd，安装随包提供的转码工具。");
      const name = new URL(media.url).pathname.split("/").pop().replace(/\.mp4$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 65);
      const filename = `x_${media.tweetId || "video"}_${name}.mp4`;
      try { await chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title: convertToGif ? "开始保存动图" : "开始保存视频", message: `正在下载到「${folder.name}」${convertToGif ? "并生成 GIF" : ""}，完成后会通知你。` }); } catch { }
      const result = await streamVideo(media.url, filename, folder, session, convertToGif);
      await reportResult({ ok: true, folder: folder.name, filename: result.filename, path: result.path, mediaType: media.type, bytes: result.bytes });
      return;
    }
    const { preferOriginal = true } = await chrome.storage.local.get("preferOriginal");
    const urls = imageUrls(source, preferOriginal);
    let image;
    let error;
    let fallback = false;
    for (let i = 0; i < urls.length; i++) {
      try { image = await fetchImage(urls[i]); fallback = i > 0; break; }
      catch (cause) { error = cause; }
    }
    if (!image) throw error;
    const result = await session.request({
      action: "save", folderId: folder.id,
      filename: imageFilename(source, image.format),
      base64: bytesToBase64(image.bytes)
    });
    await reportResult({ ok: true, folder: folder.name, filename: result.filename, path: result.path, fallback });
  } catch (error) {
    await reportResult({ ok: false, error: error.message || "保存失败，请重试。" });
  } finally { session?.close(); }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "settings") chrome.runtime.openOptionsPage();
  else if (String(info.menuItemId).startsWith("folder:")) void saveMedia(info, tab);
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => { void rebuildMenus(); });
chrome.runtime.onStartup.addListener(() => { void rebuildMenus(); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our settings page can invoke the directory picker or change host settings.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("options.html")) return false;
  (async () => {
    switch (message.action) {
      case "status": {
        const response = await nativeRequest({ action: "ping" });
        await syncFolders(response.folders);
        return response;
      }
      case "pickDirectory": return await nativeRequest({ action: "pickDirectory", initialPath: String(message.initialPath || "") }, 240000);
      case "configure": {
        const response = await nativeRequest({ action: "configure", folders: validateFolders(message.folders) });
        await chrome.storage.local.set({ preferOriginal: Boolean(message.preferOriginal), convertGifs: message.convertGifs !== false });
        await syncFolders(response.folders);
        return response;
      }
      default: throw new Error("无法识别的操作。");
    }
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
