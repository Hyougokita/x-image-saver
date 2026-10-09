// Exported helpers; the page bundles embed private copies of this module.
export function videoUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "video.twimg.com" ||
      url.username || url.password || url.port || !/\.mp4$/i.test(url.pathname)) {
    throw new Error("没有找到可下载的推特 MP4 视频地址。");
  }
  url.hash = "";
  return url.href;
}
export function posterKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || url.username || url.password || url.port) return "";
    return url.pathname.replace(/:(?:small|medium|large|orig)$/, "");
  } catch { return ""; }
}
export function variantsOf(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  for (const variant of value.slice(0, 40)) {
    try {
      const url = videoUrl(variant.url || variant.src);
      const bitrate = Number(variant.bitrate || variant.bit_rate) || 0;
      const match = new URL(url).pathname.match(/\/(\d+)x(\d+)\//);
      const area = match ? Number(match[1]) * Number(match[2]) : 0;
      unique.set(url, { url, bitrate: Number.isFinite(bitrate) ? Math.max(0, bitrate) : 0, area });
    } catch { /* HLS playlists and off-site URLs are not MP4 downloads. */ }
  }
  return [...unique.values()].sort((a, b) => b.bitrate - a.bitrate || b.area - a.area);
}
export function collectMedia(root) {
  const result = new Map();
  const stack = [{ value: root, id: "", depth: 0 }];
  const seen = new WeakSet();
  let visited = 0;
  while (stack.length && visited++ < 30000 && result.size < 100) {
    const { value, id, depth } = stack.pop();
    if (!value || typeof value !== "object" || depth > 30 || seen.has(value)) continue;
    seen.add(value);
    const ownId = value.rest_id || value.id_str || value.id;
    const tweetId = /^\d{1,22}$/.test(String(ownId)) ? String(ownId) : id;
    const raw = value.video_info?.variants || value.media_info?.variants || value.video?.variants || value.variants;
    if (Array.isArray(raw)) {
      const variants = variantsOf(raw);
      const poster = [value.media_url_https, value.media_url, value.preview_image_url, value.poster, value.video?.poster, value.url].find(posterKey) || "";
      if (variants.length) {
        const key = posterKey(poster) || variants[0].url;
        const animated = value.type === "animated_gif" || value.video?.type === "animated_gif" ||
          /\/tweet_video_thumb\//.test(poster) || variants.some(variant => /\/tweet_video\//.test(variant.url));
        result.set(key, { tweetId: id || tweetId, type: animated ? "animated_gif" : "video", poster, variants });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (["video_info", "media_info", "video"].includes(key) && child?.variants === raw) continue;
      if (child && typeof child === "object") stack.push({ value: child, id: tweetId, depth: depth + 1 });
      // X promotional cards can contain a second JSON document.
      else if (key === "string_value" && typeof child === "string" && child.length < 200000 && child.startsWith("{")) {
        try { stack.push({ value: JSON.parse(child), id: tweetId, depth: depth + 1 }); } catch { }
      }
    }
  }
  return [...result.values()];
}
export function selectMedia(items, context) {
  if (!Array.isArray(items)) return null;
  const key = posterKey(context.poster || context.srcUrl);
  if (key) {
    const matching = items.filter(item => posterKey(item.poster) === key);
    // A poster is a stronger identity than a DOM index or the enclosing retweet ID.
    if (matching.length === 1) return matching[0];
    return null;
  }
  let source;
  try { source = videoUrl(context.srcUrl); } catch { }
  if (source) {
    const match = items.find(item => variantsOf(item.variants).some(variant => variant.url === source));
    if (match) return match;
  }
  const matching = items.filter(item => context.tweetId && item.tweetId === context.tweetId);
  // Never guess which video was clicked in a multi-video tweet.
  return matching.length === 1 ? matching[0] : null;
}
export function mp4Format(bytes) {
  const at = (start, text) => [...text].every((c, i) => bytes[start + i] === c.charCodeAt(0));
  if (bytes.length < 16 || !at(4, "ftyp")) throw new Error("服务器没有返回可识别的 MP4 视频。");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (size < 16 || size > 4096) throw new Error("MP4 文件头无效。");
  for (let i = 8; i + 4 <= Math.min(size, bytes.length); i += 4) {
    if (i === 12) continue;
    if (["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "MSNV"].some(brand => at(i, brand))) return "mp4";
  }
  throw new Error("服务器返回的内容不是支持的 MP4 视频。");
}
