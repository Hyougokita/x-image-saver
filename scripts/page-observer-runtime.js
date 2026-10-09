// Runs in MAIN world: observe media metadata already received by this X page.
// No cookies, request headers, account credentials or tweet text leave this script.
const origin = location.origin;
function allowed(value) {
  try {
    const url = new URL(value, location.href);
    return url.origin === origin && url.pathname.startsWith("/i/api/");
  } catch { return false; }
}
function publish(data) {
  try {
    const items = collectMedia(data);
    if (items.length) window.postMessage({ source: "x-image-saver-media-v2", items }, origin);
  } catch { /* Observation must never break the site's request. */ }
}
const originalFetch = window.fetch;
window.fetch = function (...args) {
  const request = args[0];
  const observe = allowed(typeof request === "string" || request instanceof URL ? String(request) : request?.url);
  return originalFetch.apply(this, args).then(response => {
    if (observe && response.ok && /json/i.test(response.headers.get("content-type") || "")) {
      // A clone leaves the response body untouched for X's own code.
      void (async () => {
        const reader = response.clone().body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 8 * 1024 * 1024) { await reader.cancel(); return; }
            chunks.push(value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          publish(JSON.parse(new TextDecoder().decode(bytes)));
        } catch { } finally { reader.releaseLock(); }
      })().catch(() => {});
    }
    return response;
  });
};
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;
const observed = new WeakMap();
XMLHttpRequest.prototype.open = function (method, url, ...args) {
  observed.set(this, allowed(url));
  return originalOpen.call(this, method, url, ...args);
};
XMLHttpRequest.prototype.send = function (...args) {
  if (observed.get(this)) this.addEventListener("load", () => {
    try {
      if (!observed.get(this)) return;
      if (this.status < 200 || this.status >= 300) return;
      if (this.responseType === "json") publish(this.response);
      else if (!this.responseType || this.responseType === "text") {
        if (this.responseText.length <= 8 * 1024 * 1024) publish(JSON.parse(this.responseText));
      }
    } catch { }
  }, { once: true });
  return originalSend.apply(this, args);
};
