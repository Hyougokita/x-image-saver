// Isolated world: keep a bounded media cache and remember the exact right-click target.
const media = new Map();
let clicked = null;
window.addEventListener("message", event => {
  if (event.source !== window || event.origin !== location.origin || event.data?.source !== "x-image-saver-media-v2") return;
  const items = event.data.items;
  if (!Array.isArray(items)) return;
  for (const item of items.slice(0, 100)) {
    const variants = variantsOf(item.variants);
    const key = posterKey(item.poster) || variants[0]?.url;
    if (!key || !variants.length) continue;
    media.delete(key);
    media.set(key, { poster: posterKey(item.poster) ? item.poster : "", variants,
      type: item.type === "animated_gif" ? "animated_gif" : "video",
      tweetId: /^\d{1,22}$/.test(item.tweetId) ? item.tweetId : "" });
  }
  while (media.size > 500) media.delete(media.keys().next().value);
});
// Capture at window before X's handlers can cancel Chrome's default menu.
// Keep recording here: stopping propagation also stops document-level listeners.
window.addEventListener("contextmenu", event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) { clicked = null; return; }
  const container = target.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]');
  const video = target.closest("video") || container?.querySelector("video");
  const image = target.closest("img");
  const article = target.closest("article");
  const timeLink = article?.querySelector('a[href*="/status/"] time')?.closest("a");
  const enclosingLink = target.closest('a[href*="/status/"]');
  const tweetUrl = enclosingLink?.href || timeLink?.href || location.href;
  const tweetId = tweetUrl.match(/\/status\/(\d+)/)?.[1] || "";
  let poster = video?.poster || (container ? container.querySelector("img")?.src : image?.src) || "";
  if (!poster && container) {
    for (const element of [container, ...container.querySelectorAll('[style*="background-image"]')].slice(0, 20)) {
      const candidate = getComputedStyle(element).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      if (posterKey(candidate)) { poster = candidate; break; }
    }
  }
  clicked = { time: Date.now(), pageUrl: location.href,
    kind: video || container ? "video" : image ? "image" : "page",
    srcUrl: video?.currentSrc || video?.src || image?.currentSrc || image?.src || "",
    poster,
    animatedGif: /\/tweet_video_thumb\//.test(poster) ||
      [...(container?.querySelectorAll("span") || [])].slice(0, 40).some(element => element.textContent.trim() === "GIF"),
    tweetId };
  if ((video || container) && !event.shiftKey) {
    // Stop the site's custom menu, but do not prevent the browser's default action.
    // Shift + right-click deliberately keeps X's original video menu available.
    event.stopImmediatePropagation();
  }
}, true);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.action !== "resolveMedia") return false;
  if (!clicked || Date.now() - clicked.time > 180000 || clicked.pageUrl !== location.href) {
    reply({ context: null, media: null }); return false;
  }
  const context = { ...clicked };
  const match = selectMedia([...media.values()], context);
  reply({ context, media: match });
  return false;
});
