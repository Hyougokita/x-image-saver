import { validateFolders } from "./core.js";

const $ = id => document.getElementById(id);
let folders = [];
let connected = false;
let dirty = false;
let busy = false;

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展未能完成操作，请重新加载扩展后重试。");
  return response;
}

function message(text, type = "") {
  $("save-message").textContent = text;
  $("save-message").className = type;
}
function changed() { dirty = true; message("有未保存的修改。保存后，右键菜单会自动更新。"); }
function setBusy(value) {
  busy = value;
  document.querySelectorAll("button, input").forEach(element => { element.disabled = value; });
}

function iconButton(text, title, action, extra = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.className = `icon-button ${extra}`;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", action);
  return button;
}

function renderFolders() {
  $("folders").replaceChildren();
  $("empty").hidden = folders.length > 0;
  for (const [index, folder] of folders.entries()) {
    const row = document.createElement("div"); row.className = "folder-row";
    const top = document.createElement("div"); top.className = "row-top";
    const number = document.createElement("span"); number.className = "number"; number.textContent = String(index + 1).padStart(2, "0");
    const label = document.createElement("input"); label.type = "text"; label.className = "label-input"; label.value = folder.name; label.maxLength = 40; label.placeholder = "菜单名称，例如：插画"; label.setAttribute("aria-label", `目录 ${index + 1} 的菜单名称`);
    label.addEventListener("input", () => { folder.name = label.value; changed(); });
    const nameField = document.createElement("div"); nameField.className = "field"; nameField.append(label);
    const move = delta => { const next = index + delta; if (next < 0 || next >= folders.length) return; [folders[index], folders[next]] = [folders[next], folders[index]]; changed(); renderFolders(); };
    top.append(number, nameField, iconButton("↑", `上移目录 ${index + 1}`, () => move(-1)), iconButton("↓", `下移目录 ${index + 1}`, () => move(1)), iconButton("×", `删除目录 ${index + 1}`, () => { folders.splice(index, 1); changed(); renderFolders(); }, "remove"));
    const pathRow = document.createElement("div"); pathRow.className = "path-row";
    const path = document.createElement("input"); path.type = "text"; path.className = "path-input"; path.value = folder.path; path.placeholder = "D:\\图片\\插画"; path.setAttribute("aria-label", `目录 ${index + 1} 的保存路径`);
    path.addEventListener("input", () => { folder.path = path.value; changed(); });
    const pathField = document.createElement("div"); pathField.className = "field"; pathField.append(path);
    const browse = document.createElement("button"); browse.type = "button"; browse.className = "secondary small-button"; browse.textContent = "选择文件夹"; browse.addEventListener("click", async () => {
      setBusy(true);
      try { const result = await request({ action: "pickDirectory", initialPath: folder.path }); if (!result.cancelled) { folder.path = result.path; changed(); renderFolders(); } }
      catch (error) { message(error.message, "error"); }
      finally { setBusy(false); }
    });
    pathRow.append(pathField, browse); row.append(top, pathRow); $("folders").append(row);
  }
}

async function checkConnection() {
  if (busy) return;
  setBusy(true);
  $("connection-title").textContent = "正在连接本机助手…";
  try {
    const result = await request({ action: "status" });
    connected = true;
    $("connection-dot").className = "dot connected";
    $("connection-title").textContent = "本机助手已连接";
    $("connection-detail").textContent = result.gifConversion ? "图片、GIF 转码和视频已就绪，点击完成通知可打开文件夹。" : result.revealSaved ? "保存功能已就绪；动图转 GIF 需要运行新版 install.cmd 安装转码工具。" : result.streamingVideo ? "图片和视频保存可用；点击通知打开目录需要运行新版 install.cmd 升级助手。" : "图片保存可用；视频功能需要运行新版 install.cmd 升级本机助手。";
    if (!dirty) { folders = result.folders; renderFolders(); }
  } catch (error) {
    connected = false;
    $("connection-dot").className = "dot failed";
    $("connection-title").textContent = "本机助手尚未连接";
    $("connection-detail").textContent = error.message;
  } finally { setBusy(false); }
}

async function addFolder() {
  if (folders.length >= 20) { message("最多可以添加 20 个文件夹。", "error"); return; }
  if (!connected) { message("请先运行 install.cmd 安装本机助手，再点击「重新检测」。", "error"); return; }
  setBusy(true);
  try {
    const result = await request({ action: "pickDirectory" });
    if (!result.cancelled) {
      const trimmed = result.path.replace(/\\$/, "");
      folders.push({ id: crypto.randomUUID(), name: trimmed.split("\\").pop() || "图片", path: result.path });
      changed(); renderFolders();
    }
  } catch (error) { message(error.message, "error"); }
  finally { setBusy(false); }
}

async function save() {
  if (!connected) { message("本机助手未连接，请先安装并重新检测。", "error"); return; }
  setBusy(true);
  try {
    const result = await request({ action: "configure", folders: validateFolders(folders), preferOriginal: $("original").checked, convertGifs: $("convert-gifs").checked });
    folders = result.folders; dirty = false; renderFolders();
    message("设置已保存，右键菜单已经更新。", "success");
  } catch (error) { message(error.message, "error"); }
  finally { setBusy(false); }
}

function renderRecent(recent) {
  $("recent").replaceChildren();
  if (!recent.length) { const p = document.createElement("p"); p.className = "note"; p.textContent = "还没有保存记录。"; $("recent").append(p); return; }
  for (const item of recent) {
    const row = document.createElement("div"); row.className = "recent-item";
    const mark = document.createElement("span"); mark.className = item.ok ? "recent-mark" : "recent-mark error"; mark.textContent = item.ok ? "✓" : "!";
    const text = document.createElement("div"); text.className = "recent-text";
    const title = document.createElement("strong"); title.textContent = item.ok ? `已保存 · ${item.folder}` : "保存失败";
    const detail = document.createElement("p"); detail.textContent = item.ok ? `${item.path}${item.fallback ? "（当前尺寸）" : ""}` : item.error;
    text.append(title, detail);
    const time = document.createElement("span"); time.className = "recent-time"; time.textContent = new Date(item.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    row.append(mark, text, time); $("recent").append(row);
  }
}

$("check").addEventListener("click", checkConnection);
$("add").addEventListener("click", addFolder);
$("add-first").addEventListener("click", addFolder);
$("save").addEventListener("click", save);
$("original").addEventListener("change", changed);
$("convert-gifs").addEventListener("change", changed);
window.addEventListener("beforeunload", event => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
chrome.storage.onChanged.addListener(changes => { if (changes.recent) renderRecent(changes.recent.newValue || []); });
const state = await chrome.storage.local.get(["folders", "preferOriginal", "convertGifs", "recent"]);
folders = state.folders || [];
$("original").checked = state.preferOriginal !== false;
$("convert-gifs").checked = state.convertGifs !== false;
renderFolders(); renderRecent(state.recent || []);
await checkConnection();
