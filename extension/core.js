export const HOST_NAME = "com.local.x_image_saver";
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_PATTERNS = [
  "https://*.x.com/*", "https://*.twitter.com/*", "https://pbs.twimg.com/*"
];

export function isAllowedPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "x.com" || url.hostname.endsWith(".x.com") ||
       url.hostname === "twitter.com" || url.hostname.endsWith(".twitter.com") ||
       url.hostname === "pbs.twimg.com");
  } catch { return false; }
}

export function imageUrls(source, preferOriginal = true) {
  const url = new URL(source);
  if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" ||
      url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("这张图片不来自推特的图片服务器，目前仅支持 pbs.twimg.com 的图片。");
  }
  url.hash = "";
  const displayed = url.href;
  if (!preferOriginal || !url.pathname.startsWith("/media/")) return [displayed];
  const original = new URL(url);
  const match = original.pathname.match(/\.(jpg|jpeg|png|webp|gif|avif)(?::[a-z0-9]+)?$/i);
  if (match) {
    original.pathname = original.pathname.slice(0, match.index);
    original.searchParams.set("format", match[1].toLowerCase());
  }
  if (!original.searchParams.has("format")) original.searchParams.set("format", "jpg");
  original.searchParams.set("name", "orig");
  return [...new Set([original.href, displayed])];
}

export function imageFormat(bytes) {
  const at = (start, text) => text.split("").every((char, i) => bytes[start + i] === char.charCodeAt(0));
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) return "png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "gif";
  if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "webp";
  if (bytes.length >= 16 && at(4, "ftyp") && (at(8, "avif") || at(8, "avis"))) return "avif";
  throw new Error("服务器没有返回可识别的图片（支持 JPG、PNG、WebP、GIF、AVIF）。");
}

export function imageFilename(source, format) {
  let name = decodeURIComponent(new URL(source).pathname.split("/").pop() || "image");
  name = name.replace(/\.(jpg|jpeg|png|webp|gif|avif)(?::[a-z0-9]+)?$/i, "");
  name = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100) || "image";
  return `x_${name}.${format}`;
}

export function bytesToBase64(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 32768) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  }
  return btoa(parts.join(""));
}

export function validateFolders(folders) {
  if (!Array.isArray(folders) || folders.length > 20) throw new Error("最多可以设置 20 个文件夹。");
  const seen = new Set();
  return folders.map(folder => {
    if (typeof folder.id !== "string" || !/^[a-f0-9-]{36}$/i.test(folder.id) || seen.has(folder.id)) {
      throw new Error("文件夹编号无效，请删除该条目后重新添加。");
    }
    seen.add(folder.id);
    const name = String(folder.name || "").trim();
    const path = String(folder.path || "").trim();
    if (!name || name.length > 40) throw new Error("请为每个目录填写 1–40 个字的菜单名称。");
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(path) || path.length > 220) {
      throw new Error(`「${name}」需要完整的 Windows 文件夹路径，例如 D:\\图片。`);
    }
    return { id: folder.id, name, path };
  });
}
