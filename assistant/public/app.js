"use strict";
const $ = (id) => document.getElementById(id);
const icon = (name) => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide?.createIcons();
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uuid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const n = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
        return (c === "x" ? n : (n & 3) | 8).toString(16);
      });
const storage = {
  get(key) {
    try {
      return localStorage.getItem(`transfer-${key}`);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`transfer-${key}`, value);
    } catch {}
  },
};
function defaultName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua)
    ? "我的 iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
      ? "我的 iPad"
      : /Android/.test(ua)
        ? "我的手机"
        : /Windows/.test(ua)
          ? "我的 Windows"
          : /Mac/.test(ua)
            ? "我的 Mac"
            : "我的电脑";
}
const state = {
  deviceId: storage.get("device-id") || uuid(),
  deviceName: storage.get("device-name") || defaultName(),
  initialized: false,
  filter: "all",
  query: "",
  messages: [],
  hasMore: false,
  stream: null,
  stats: {},
  queue: [],
  sending: false,
  active: false,
  refreshVersion: 0,
  pendingText: null,
  followBottom: true,
  purging: false,
  trashPreview: null,
  dateScope: null,
  datePreview: null,
  dateBusy: false,
};
storage.set("device-id", state.deviceId);
function size(bytes) {
  if (!bytes) return "0 B";
  const n = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** n).toFixed(n === 0 || bytes / 1024 ** n >= 100 ? 0 : 1)} ${["B", "KB", "MB", "GB"][n]}`;
}
let toastTimer;
function toast(text, error = false) {
  $("toast").textContent = text;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      $("toast").hidden = true;
    },
    error ? 5500 : 3000,
  );
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-Assistant-Request": "1",
      "X-Device-Id": state.deviceId,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
    credentials: "same-origin",
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.active) {
      state.active = false;
      state.stream?.close();
      showAuth();
    }
    const error = new Error(data.error || "请求失败，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return data;
}
function showAuth() {
  state.active = false;
  state.stream?.close();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  resetPasswordForm();
  document.body.classList.remove("chat-open");
  closeSidebar(false);
  $("boot").hidden = true;
  $("workspace").hidden = true;
  $("auth").hidden = false;
  $("auth-title").textContent = state.initialized
    ? "欢迎回来"
    : "拥有自己的传输助手";
  $("auth-description").textContent = state.initialized
    ? "输入访问密码，接着上次的记录。"
    : "先设置一个密码，以后所有设备都用它进入。";
  $("auth-submit").innerHTML =
    `${state.initialized ? "进入我的传输助手" : "设置密码并开始"} ${icon("arrow-right")}`;
  $("confirm-wrap").hidden = state.initialized;
  $("confirm-password").required = !state.initialized;
  $("password").autocomplete = state.initialized
    ? "current-password"
    : "new-password";
  $("password").minLength = state.initialized ? 1 : 8;
  $("password").placeholder = state.initialized
    ? "请输入访问密码"
    : "至少 8 位，建议使用较长的密码";
  icons();
}
$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("password").value;
  if (!state.initialized && password !== $("confirm-password").value) {
    $("auth-error").textContent = "两次输入的密码不一致。";
    return;
  }
  $("auth-error").textContent = "";
  $("auth-submit").disabled = true;
  try {
    await api(state.initialized ? "/api/login" : "/api/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.initialized = true;
    $("password").value = "";
    $("confirm-password").value = "";
    await openWorkspace();
  } catch (error) {
    $("auth-error").textContent = error.message;
  } finally {
    $("auth-submit").disabled = false;
  }
});
$("toggle-password").addEventListener("click", () => {
  const hidden = $("password").type === "password";
  $("password").type = hidden ? "text" : "password";
  $("toggle-password").setAttribute(
    "aria-label",
    hidden ? "隐藏密码" : "显示密码",
  );
  $("toggle-password").innerHTML = icon(hidden ? "eye-off" : "eye");
  icons();
});
function deviceIcon(name) {
  return /手机|iPhone|Android/.test(name)
    ? "smartphone"
    : /iPad|平板/.test(name)
      ? "tablet"
      : /Mac/.test(name)
        ? "laptop"
        : "monitor";
}
async function openWorkspace() {
  await api("/api/devices", {
    method: "POST",
    body: JSON.stringify({ id: state.deviceId, name: state.deviceName }),
  });
  state.active = true;
  document.body.classList.add("chat-open");
  $("boot").hidden = true;
  $("auth").hidden = true;
  $("workspace").hidden = false;
  $("composer-device").textContent = state.deviceName;
  $("device-name").value = state.deviceName;
  $("message-input").value = storage.get("draft") || "";
  updateSend();
  await Promise.all([refreshMessages(true), refreshStats()]);
  connect();
  icons();
}
function connection(online, text) {
  $("connection-dot").classList.toggle("offline", !online);
  $("connection-text").textContent = text;
}
function renderDevices(devices) {
  $("device-count").textContent = devices.length;
  $("device-list").innerHTML = devices
    .map(
      (d) =>
        `<div class="device-row">${icon(deviceIcon(d.name))}<span>${escapeHtml(d.name)}</span>${d.id === state.deviceId ? "<em>本机</em>" : ""}<b class="status-dot"></b></div>`,
    )
    .join("");
  connection(
    true,
    devices.length > 1
      ? `${devices.length} 台设备在线 · 已同步`
      : "已连接 · 历史实时同步",
  );
  icons();
}
let refreshTimer;
function connect() {
  state.stream?.close();
  state.stream = new EventSource(
    `/api/events?deviceId=${encodeURIComponent(state.deviceId)}`,
  );
  state.stream.onopen = () => {
    connection(true, "已连接 · 历史实时同步");
    if (state.active) refreshAll();
  };
  state.stream.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "session-revoked") {
        showAuth();
        $("auth-error").textContent = "访问密码已修改，请使用新密码重新登录。";
      } else if (data.type === "presence") renderDevices(data.devices);
      else {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshAll, 100);
      }
    } catch {}
  };
  state.stream.onerror = () => {
    connection(false, "连接中断，正在重连…");
    $("device-list").replaceChildren();
    $("device-count").textContent = "—";
  };
}
async function refreshAll() {
  if (!state.active) return;
  try {
    await Promise.all([refreshMessages(), refreshStats()]);
  } catch (error) {
    connection(
      false,
      error.status === 401 ? "请重新登录" : "暂时无法同步，正在重试…",
    );
  }
}
async function refreshStats() {
  const stats = await api("/api/stats");
  state.stats = stats;
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = stats[el.dataset.count] || 0;
  });
  $("storage-value").textContent = size(stats.usedBytes);
  $("storage-progress").value = (stats.usedBytes / stats.maxStorageBytes) * 100;
  $("settings-storage").textContent =
    `${size(stats.usedBytes)} / ${size(stats.maxStorageBytes)}`;
  $("file-limit").textContent = size(stats.maxFileBytes);
  updateTrashSettings();
}
function updateTrashSettings() {
  const { trash = 0, trashRetentionDays = 7, pendingDeletionFiles = 0 } = state.stats;
  const policy = trashRetentionDays
    ? `删除满 ${trashRetentionDays} 天后自动清理，每小时检查一次。`
    : "自动清理已关闭，可手动清空。";
  $("trash-summary").textContent = `共 ${trash} 条。${policy}`;
  $("history-note").textContent = `${policy}清理前可恢复，仍占用存储空间。`;
  $("pending-cleanup").hidden = !pendingDeletionFiles;
  $("pending-cleanup").textContent = `有 ${pendingDeletionFiles} 个附件等待释放空间，服务会每小时重试。`;
  for (const id of ["empty-trash", "settings-empty-trash"])
    $(id).disabled = !trash || state.purging ||
      (id === "settings-empty-trash" && $("settings-dialog").dataset.busy === "true");
}
function queryParams() {
  const params = new URLSearchParams();
  if (["text", "image", "file"].includes(state.filter))
    params.set("kind", state.filter);
  if (state.filter === "trash") params.set("trash", "1");
  if (state.query) params.set("q", state.query);
  return params;
}
function localDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function resetDatePreview() {
  state.datePreview = null;
  $("date-delete-preview").hidden = true;
  $("date-delete-error").textContent = "";
  $("date-delete-submit").textContent = "查看匹配记录";
  $("date-delete-submit").className = "small-primary";
  $("date-delete-submit").disabled = false;
  const mode = $("date-delete-mode").value;
  $("date-start-label").textContent = mode === "before" ? "截止日期（不含当天）" : mode === "day" ? "选择日期" : "开始日期（含当天）";
  $("date-end-field").hidden = mode !== "range";
  $("date-delete-end").required = mode === "range";
  $("date-delete-end").disabled = mode !== "range";
  $("date-delete-end").min = $("date-delete-start").value || "1970-01-01";
}
function dateDeleteRange() {
  const mode = $("date-delete-mode").value;
  const startValue = $("date-delete-start").value;
  const endValue = mode === "range" ? $("date-delete-end").value : startValue;
  const start = new Date(`${startValue}T00:00:00`);
  const end = new Date(`${endValue}T00:00:00`);
  if (!startValue || !endValue || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start)
    throw new Error("请选择有效日期，开始日期不能晚于结束日期。");
  const params = new URLSearchParams(state.dateScope);
  if (mode === "before") params.set("until", start.getTime());
  else {
    params.set("from", start.getTime());
    // Increment the calendar day, preserving 23/25-hour days in DST time zones.
    end.setDate(end.getDate() + 1);
    params.set("until", end.getTime());
  }
  const label = mode === "before" ? `${startValue} 之前（不含当天）`
    : mode === "day" ? `${startValue} 全天`
      : `${startValue} 至 ${endValue}（含起止两天）`;
  return { params, label };
}
async function loadDatePreview() {
  const { params, label } = dateDeleteRange();
  state.dateBusy = true;
  setDialogBusy("date-delete-dialog", true);
  $("date-delete-submit").textContent = "正在统计…";
  try {
    const result = await api(`/api/messages/selection?${params}`);
    if (!$("date-delete-dialog").open || !state.active) return;
    state.datePreview = { ids: result.ids, deleted: true };
    $("date-delete-count").textContent = result.ids.length ? `共 ${result.ids.length} 条记录 · 附件 ${size(result.bytes)}` : "这个日期范围内没有记录";
    $("date-delete-range").textContent = label;
    $("date-delete-note").textContent = result.ids.length
      ? "包含未加载的旧记录。确认后整批移入最近删除，清理前可恢复；附件仍占用空间。"
      : "可以更换日期或调整分类、搜索条件。";
    $("date-delete-preview").hidden = false;
  } finally {
    state.dateBusy = false;
    setDialogBusy("date-delete-dialog", false);
    const count = state.datePreview?.ids.length;
    $("date-delete-submit").textContent = count ? `确认删除 ${count} 条` : "查看匹配记录";
    $("date-delete-submit").className = count ? "danger-button danger-solid" : "small-primary";
    $("date-delete-submit").disabled = state.datePreview !== null && !count;
  }
}
async function openDateDelete(day = "") {
  if (state.filter === "trash" || state.dateBusy) return;
  state.dateScope = queryParams().toString();
  $("date-delete-form").reset();
  $("date-delete-mode").value = day ? "day" : "before";
  $("date-delete-start").value = day;
  $("date-delete-scope").textContent = `范围：${state.filter === "all" ? "全部消息" : $("view-title").textContent}${state.query ? `，搜索“${state.query}”` : ""}。按记录的发送日期批量删除。`;
  $("date-delete-zone").textContent = `日期与聊天记录一致，按当前设备时区（${Intl.DateTimeFormat().resolvedOptions().timeZone}）计算。`;
  resetDatePreview();
  $("date-delete-dialog").showModal();
  if (day) {
    try { await loadDatePreview(); }
    catch (error) { $("date-delete-error").textContent = error.message; }
  } else $("date-delete-start").focus();
}
$("open-date-delete").addEventListener("click", () => openDateDelete());
for (const id of ["date-delete-mode", "date-delete-start", "date-delete-end"])
  $(id).addEventListener("input", resetDatePreview);
document.querySelectorAll("[data-days-before]").forEach((button) => {
  button.addEventListener("click", () => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Number(button.dataset.daysBefore));
    $("date-delete-mode").value = "before";
    $("date-delete-start").value = localDateValue(cutoff);
    resetDatePreview();
  });
});
$("date-delete-dialog").addEventListener("close", () => {
  state.datePreview = null;
  state.dateScope = null;
});
$("date-delete-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.dateBusy) return;
  $("date-delete-error").textContent = "";
  if (!state.datePreview) {
    try { await loadDatePreview(); }
    catch (error) { $("date-delete-error").textContent = error.message; }
    return;
  }
  if (!state.datePreview.ids.length) return;
  state.dateBusy = true;
  setDialogBusy("date-delete-dialog", true);
  $("date-delete-submit").textContent = "正在删除…";
  let succeeded = false;
  let stale = false;
  try {
    const result = await api("/api/messages/batch", { method: "PATCH", body: JSON.stringify(state.datePreview) });
    succeeded = true;
    $("date-delete-dialog").close();
    toast(`已将 ${result.changedCount} 条记录移到最近删除`);
    await refreshAll();
  } catch (error) {
    stale = error.status === 409;
    $("date-delete-error").textContent = stale ? "这些记录已在其他设备上发生变化，本次未作更改。请重新查看匹配记录后再确认。" : error.message;
  } finally {
    state.dateBusy = false;
    setDialogBusy("date-delete-dialog", false);
    if (stale) {
      state.datePreview = null;
      $("date-delete-preview").hidden = true;
    }
    $("date-delete-submit").textContent = state.datePreview ? `确认删除 ${state.datePreview.ids.length} 条` : "查看匹配记录";
    $("date-delete-submit").className = state.datePreview ? "danger-button danger-solid" : "small-primary";
    if (succeeded && state.active) $("open-date-delete").focus();
  }
});
async function refreshMessages(forceBottom = false, earlier = false) {
  const version = ++state.refreshVersion;
  const params = queryParams();
  if (earlier && state.messages.length)
    params.set("before", state.messages[0].id);
  const container = $("messages");
  const nearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 160;
  const priorHeight = container.scrollHeight;
  const priorTop = container.scrollTop;
  const previousLast = state.messages.at(-1)?.id;
  let data = await api(`/api/messages?${params}`);
  if (version !== state.refreshVersion) return;
  // Keep previously loaded history in place when a live update arrives.
  const anchor =
    !earlier && !forceBottom && state.messages.length > 60
      ? state.messages[0].id
      : null;
  if (anchor) {
    while (data.hasMore && data.messages[0]?.id > anchor) {
      const olderParams = queryParams();
      olderParams.set("before", data.messages[0].id);
      const older = await api(`/api/messages?${olderParams}`);
      if (version !== state.refreshVersion) return;
      data = {
        messages: [...older.messages, ...data.messages],
        hasMore: older.hasMore,
      };
    }
    const omittedOlder = data.messages.some((message) => message.id < anchor);
    data.messages = data.messages.filter((message) => message.id >= anchor);
    data.hasMore = omittedOlder || data.hasMore;
  }
  state.hasMore = data.hasMore;
  if (earlier) state.messages = [...data.messages, ...state.messages];
  else state.messages = data.messages;
  state.followBottom = !earlier && (forceBottom || nearBottom);
  renderMessages();
  if (earlier)
    container.scrollTop = container.scrollHeight - priorHeight + priorTop;
  else if (forceBottom || nearBottom) {
    container.scrollTop = container.scrollHeight;
    $("new-messages").hidden = true;
  } else {
    container.scrollTop = priorTop;
    if (previousLast && state.messages.at(-1)?.id !== previousLast)
      $("new-messages").hidden = false;
  }
}
function richText(text) {
  return text
    .split(/(https?:\/\/[^\s<>]+)/g)
    .map((part, i) =>
      i % 2
        ? `<a href="${escapeHtml(part)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part)}</a>`
        : escapeHtml(part),
    )
    .join("");
}
function dateLabel(stamp) {
  const date = new Date(stamp),
    today = new Date(),
    yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
function renderMessages() {
  let day = "";
  $("message-list").innerHTML = state.messages
    .map((message) => {
      const label = dateLabel(message.createdAt);
      const divider = day !== label
        ? `<div class="date-divider"><span>${label}</span>${state.filter !== "trash" ? `<button type="button" class="date-delete-shortcut" data-delete-date="${localDateValue(new Date(message.createdAt))}" aria-label="删除 ${escapeHtml(label)} 的记录">删除这天</button>` : ""}</div>` : "";
      day = label;
      const own = message.deviceId === state.deviceId,
        trash = state.filter === "trash";
      const time = new Date(message.createdAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      let content;
      const url = `/api/files/${message.id}`;
      if (message.kind === "text")
        content = `<div class="bubble">${richText(message.text)}</div>`;
      else if (message.kind === "image" && !trash)
        content = `<button class="image-card" data-action="preview" data-id="${message.id}" aria-label="预览 ${escapeHtml(message.fileName)}"><img src="${url}?preview=1" alt="${escapeHtml(message.fileName)}" loading="lazy"></button>`;
      else {
        const ext = (message.fileName?.split(".").pop() || "").slice(0, 6);
        const type = /pdf/i.test(ext)
          ? "pdf"
          : /zip|rar|gz|7z/i.test(ext)
            ? "archive"
            : "";
        const tag = trash ? "div" : "button";
        content = `<${tag} class="file-card" ${trash ? "" : `data-action="download" data-id="${message.id}"`}><span class="file-icon ${type}">${icon(message.kind === "image" ? "image" : "file-text")}<span>${escapeHtml(ext)}</span></span><span class="file-info"><strong>${escapeHtml(message.fileName)}</strong><span>${size(message.size)}${trash ? " · 已删除" : " · 已保存"}</span></span>${trash ? "" : icon("arrow-down-to-line")}</${tag}>`;
      }
      let actions = trash
        ? `<button data-action="restore" data-id="${message.id}">${icon("archive-restore")}恢复</button>`
        : `${message.kind === "text" ? `<button data-action="copy" data-id="${message.id}">${icon("copy")}复制</button>` : `<a href="${url}" download>${icon("download")}下载</a>`}<button data-action="delete" data-id="${message.id}">${icon("trash-2")}删除</button>`;
      return `${divider}<article class="message ${own ? "own" : ""} ${trash ? "trash" : ""}" data-message-id="${message.id}"><div class="message-avatar">${icon(deviceIcon(message.deviceName))}</div><div class="message-body"><div class="message-meta"><span>${escapeHtml(message.deviceName)}</span><time datetime="${new Date(message.createdAt).toISOString()}">${time}</time></div>${content}<div class="message-actions">${actions}</div></div></article>`;
    })
    .join("");
  $("load-more").hidden = !state.hasMore;
  $("empty").hidden = !!state.messages.length;
  const filtered = state.filter !== "all" || state.query;
  $("empty-title").textContent = state.query
    ? "没有找到相关记录"
    : state.filter === "trash"
      ? "最近删除是空的"
      : filtered
        ? "这里还没有记录"
        : "给自己发点什么";
  $("empty-description").textContent = state.query
    ? "换个关键词试试，可以搜索文字内容和文件名。"
    : state.filter === "trash"
      ? "删除的记录会先放到这里，方便找回。"
      : filtered
        ? "发送的内容会自动归类到这里。"
        : "一段文字、一张截图，或一个文件。\n从这里开始，在你的设备之间流转。";
  $("empty-description").style.whiteSpace = "pre-line";
  $("empty-tips").hidden = filtered;
  $("search-summary").hidden = !state.query;
  $("search-summary").textContent =
    `搜索“${state.query}” · ${state.messages.length}${state.hasMore ? "+" : ""} 条记录`;
  $("open-date-delete").hidden = state.filter === "trash";
  icons();
  $("message-list")
    .querySelectorAll("img")
    .forEach((image) => {
      image.addEventListener(
        "error",
        () => {
          image.alt = "图片暂时无法加载，请使用下载按钮重试";
        },
        { once: true },
      );
      image.addEventListener(
        "load",
        () => {
          if (state.followBottom)
            $("messages").scrollTop = $("messages").scrollHeight;
        },
        { once: true },
      );
    });
}
async function selectFilter(filter) {
  state.filter = filter;
  state.messages = [];
  state.hasMore = false;
  renderMessages();
  document.querySelectorAll("[data-filter]").forEach((el) => {
    const active = el.dataset.filter === filter;
    el.classList.toggle("active", active);
    el.setAttribute("aria-current", active ? "page" : "false");
  });
  const labels = {
    all: "文件传输助手",
    text: "文字与链接",
    image: "图片",
    file: "文件",
    trash: "最近删除",
  };
  $("view-title").textContent = labels[filter];
  $("history-note").hidden = filter !== "trash";
  $("composer").hidden = filter === "trash";
  $("trash-bottom").hidden = filter !== "trash";
  closeSidebar();
  try {
    await refreshMessages(true);
  } catch (error) {
    toast(error.message, true);
  }
}
document
  .querySelectorAll("[data-filter]")
  .forEach((button) =>
    button.addEventListener("click", () => selectFilter(button.dataset.filter)),
  );
for (const id of ["chat-button", "home-button"])
  $(id).addEventListener("click", () => {
    $("search").value = "";
    state.query = "";
    selectFilter("all");
  });
$("load-more").addEventListener("click", async () => {
  $("load-more").disabled = true;
  try {
    await refreshMessages(false, true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("load-more").disabled = false;
  }
});
let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  state.query = $("search").value.trim();
  state.messages = [];
  state.hasMore = false;
  state.refreshVersion++;
  renderMessages();
  searchTimer = setTimeout(() => {
    refreshMessages(true).catch((error) => toast(error.message, true));
  }, 220);
});
$("search-toggle").addEventListener("click", () => {
  document.querySelector(".chat-header").classList.toggle("searching");
  if (document.querySelector(".chat-header").classList.contains("searching"))
    $("search").focus();
});
$("new-messages").addEventListener("click", () => {
  $("messages").scrollTop = $("messages").scrollHeight;
  $("new-messages").hidden = true;
});
$("messages").addEventListener(
  "scroll",
  () => {
    state.followBottom =
      $("messages").scrollHeight -
        $("messages").scrollTop -
        $("messages").clientHeight <
      80;
    if (state.followBottom) $("new-messages").hidden = true;
  },
  { passive: true },
);
async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
      return;
    } catch {}
  }
  // 局域网 HTTP 没有 Clipboard API；在点击事件内直接尝试兼容复制。
  if (copyTextWithSelection(text)) {
    toast("已复制");
    return;
  }
  const content = $("copy-content");
  content.value = text;
  $("copy-dialog").showModal();
  content.focus({ preventScroll: true });
  content.select();
  content.setSelectionRange(0, content.value.length);
}
function copyTextWithSelection(text) {
  const previousFocus = document.activeElement;
  const content = document.createElement("textarea");
  content.className = "clipboard-copy-target";
  content.readOnly = true;
  content.tabIndex = -1;
  content.value = text;
  document.body.append(content);
  try {
    content.focus({ preventScroll: true });
    content.select();
    content.setSelectionRange(0, content.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    content.remove();
    previousFocus?.focus({ preventScroll: true });
  }
}
function download(id) {
  const a = document.createElement("a");
  a.href = `/api/files/${id}`;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}
$("message-list").addEventListener("click", async (event) => {
  const dateButton = event.target.closest("[data-delete-date]");
  if (dateButton) {
    await openDateDelete(dateButton.dataset.deleteDate);
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const message = state.messages.find(
    (m) => m.id === Number(button.dataset.id),
  );
  if (!message) return;
  try {
    if (button.dataset.action === "copy") await copyText(message.text);
    else if (button.dataset.action === "download") download(message.id);
    else if (button.dataset.action === "preview") {
      $("preview-image").src = `/api/files/${message.id}?preview=1`;
      $("preview-name").textContent = message.fileName;
      $("preview-download").href = `/api/files/${message.id}`;
      $("image-dialog").showModal();
    } else {
      button.disabled = true;
      const deleted = button.dataset.action === "delete";
      await api(`/api/messages/${message.id}`, {
        method: "PATCH",
        body: JSON.stringify({ deleted }),
      });
      await refreshAll();
      toast(deleted ? "已移到最近删除，可随时恢复" : "已恢复到聊天记录");
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});
function updateSend() {
  $("send-button").disabled =
    state.sending ||
    (!$("message-input").value.trim() &&
      !state.queue.some((item) => item.status === "waiting"));
  resizeComposer();
}

const compactLayout = matchMedia(
  "(max-width: 900px), (max-width: 1100px) and (max-height: 500px)",
);
function resizeComposer() {
  const input = $("message-input");
  if (compactLayout.matches) {
    const scrollTop = input.scrollTop;
    input.placeholder = "发送消息…";
    input.rows = 1;
    input.style.height = "44px";
    const visibleHeight =
      parseFloat(
        document.documentElement.style.getPropertyValue("--app-height"),
      ) || innerHeight;
    const limit = Math.max(44, Math.min(120, visibleHeight * 0.25));
    input.style.height = `${Math.max(44, Math.min(input.scrollHeight + 2, limit))}px`;
    input.scrollTop =
      document.activeElement === input &&
      input.selectionStart === input.selectionEnd &&
      input.selectionEnd === input.value.length
        ? input.scrollHeight
        : scrollTop;
  } else {
    input.placeholder = "发送文字，或粘贴截图…";
    input.rows = 3;
    input.style.removeProperty("height");
  }
}
function toggleAttachments(open) {
  $("composer").classList.toggle("attachments-open", open);
  $("toggle-attachments").setAttribute("aria-expanded", String(open));
  $("toggle-attachments").setAttribute(
    "aria-label",
    open ? "收起附件选项" : "展开附件选项",
  );
}
$("toggle-attachments").addEventListener("click", () => {
  const open = !$("composer").classList.contains("attachments-open");
  if (open) $("message-input").blur();
  toggleAttachments(open);
});
$("message-input").addEventListener("focus", () => {
  if (compactLayout.matches) toggleAttachments(false);
});
$("send-button").addEventListener("pointerdown", (event) => {
  if (compactLayout.matches && document.activeElement === $("message-input"))
    event.preventDefault();
});
const composerObserver = new ResizeObserver(() => {
  const height = $("composer").getBoundingClientRect().height;
  document.documentElement.style.setProperty(
    "--composer-height",
    `${height}px`,
  );
  if (state.followBottom) $("messages").scrollTop = $("messages").scrollHeight;
});
composerObserver.observe($("composer"));
window.addEventListener("assistant:viewport", () => {
  resizeComposer();
  if (state.followBottom)
    requestAnimationFrame(() => {
      $("messages").scrollTop = $("messages").scrollHeight;
    });
});
compactLayout.addEventListener("change", () => {
  closeSidebar(false);
  toggleAttachments(false);
  resizeComposer();
});
$("message-input").addEventListener("input", () => {
  storage.set("draft", $("message-input").value);
  updateSend();
});
$("message-input").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !matchMedia("(pointer:coarse)").matches
  ) {
    event.preventDefault();
    if (!$("send-button").disabled) $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.sending) return;
  const text = $("message-input").value;
  if (text.trim()) {
    state.sending = true;
    updateSend();
    if (!state.pendingText || state.pendingText.text !== text)
      state.pendingText = { text, requestId: uuid() };
    try {
      await api("/api/messages", {
        method: "POST",
        body: JSON.stringify(state.pendingText),
      });
      if ($("message-input").value === text) {
        $("message-input").value = "";
        storage.set("draft", "");
      }
      state.pendingText = null;
      if (state.filter !== "all" || state.query) {
        state.query = "";
        $("search").value = "";
        await selectFilter("all");
      } else await refreshMessages(true);
      await refreshStats();
    } catch (error) {
      toast(error.message, true);
    } finally {
      state.sending = false;
      updateSend();
    }
  }
  processQueue();
});
function addFiles(files) {
  if (!state.active) return;
  let skipped = 0;
  for (const file of files) {
    if (file.size > state.stats.maxFileBytes) {
      toast(
        `${file.name} 超过 ${size(state.stats.maxFileBytes)}，请选小一点的文件。`,
        true,
      );
      continue;
    }
    if (state.queue.length >= 30) {
      skipped++;
      continue;
    }
    state.queue.push({
      id: uuid(),
      file,
      status: "waiting",
      percent: 0,
      requestId: uuid(),
      error: "",
    });
  }
  if (skipped) toast("每批最多 30 个文件，请发送后再继续添加。", true);
  renderQueue();
  updateSend();
  if (compactLayout.matches) toggleAttachments(false);
}
function renderQueue() {
  $("upload-queue").innerHTML = state.queue
    .map(
      (item) =>
        `<div class="queue-item ${item.status === "error" ? "error" : ""}">${icon(item.file.type.startsWith("image/") ? "image" : "file")}<div class="queue-text"><strong title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><span>${item.status === "uploading" ? (item.percent >= 100 ? "正在保存…" : `正在上传 ${item.percent}%`) : item.status === "error" ? escapeHtml(item.error) : `${size(item.file.size)} · 等待发送`}</span></div><button type="button" class="icon-button" data-queue-action="${item.status === "error" ? "retry" : "remove"}" data-id="${item.id}" aria-label="${item.status === "error" ? "重试上传" : "移除文件"}" title="${item.status === "error" ? "重试上传" : "移除文件"}">${icon(item.status === "error" ? "rotate-cw" : "x")}</button>${item.status === "uploading" ? `<progress value="${item.percent}" max="100" aria-label="上传进度"></progress>` : ""}</div>`,
    )
    .join("");
  icons();
}
let queueRunning = false;
async function processQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (const item of state.queue) {
      if (item.status !== "waiting") continue;
      item.status = "uploading";
      renderQueue();
      updateSend();
      try {
        await uploadFile(item);
        item.status = "done";
        await refreshStats();
        if (state.filter !== "all" || state.query) {
          state.query = "";
          $("search").value = "";
          await selectFilter("all");
        } else await refreshMessages(true);
      } catch (error) {
        if (item.status !== "cancelled") {
          item.status = "error";
          item.error = error.message;
        }
      }
      state.queue = state.queue.filter(
        (i) => !["done", "cancelled"].includes(i.status),
      );
      renderQueue();
      updateSend();
    }
  } finally {
    queueRunning = false;
  }
  if (state.queue.some((item) => item.status === "waiting")) processQueue();
}
function uploadFile(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("POST", "/api/files");
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader("X-Assistant-Request", "1");
    xhr.setRequestHeader("X-Device-Id", state.deviceId);
    xhr.setRequestHeader("X-Request-Id", item.requestId);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        item.percent = Math.round((event.loaded / event.total) * 100);
        renderQueue();
      }
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        reject(new Error("上传未完成，请重试。"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        if (xhr.status === 401) {
          state.active = false;
          state.stream?.close();
          showAuth();
        }
        reject(new Error(data.error || "上传失败，请重试。"));
      }
    };
    xhr.onerror = () => reject(new Error("网络中断，点击重试。"));
    xhr.ontimeout = () => reject(new Error("上传超时，点击重试。"));
    xhr.onabort = () => reject(new Error("已取消上传"));
    const data = new FormData();
    data.append("file", item.file, item.file.name);
    xhr.send(data);
  });
}
$("upload-queue").addEventListener("click", (event) => {
  const button = event.target.closest("[data-queue-action]");
  if (!button) return;
  const item = state.queue.find((i) => i.id === button.dataset.id);
  if (!item) return;
  if (button.dataset.queueAction === "retry") {
    item.status = "waiting";
    item.percent = 0;
    processQueue();
  } else {
    item.status = "cancelled";
    item.xhr?.abort();
    state.queue = state.queue.filter((i) => i.id !== item.id);
    renderQueue();
    updateSend();
  }
});
$("attach-file").addEventListener("click", () => $("file-input").click());
$("attach-image").addEventListener("click", () => $("image-input").click());
for (const id of ["file-input", "image-input"])
  $(id).addEventListener("change", (event) => {
    addFiles([...event.target.files]);
    event.target.value = "";
  });
$("message-input").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items || [])]
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (files.length) {
    event.preventDefault();
    addFiles(
      files.map((file) =>
        file.name === "image.png"
          ? new File(
              [file],
              `截图-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
              { type: file.type },
            )
          : file,
      ),
    );
  }
});
let dragDepth = 0;
document.addEventListener("dragenter", (event) => {
  if (!state.active || !event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  dragDepth++;
  $("drop-zone").hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (state.active && event.dataTransfer.types.includes("Files")) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("dragleave", (event) => {
  if (event.dataTransfer.types.includes("Files")) {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("drop-zone").hidden = true;
  }
});
document.addEventListener("drop", (event) => {
  if (!state.active) return;
  event.preventDefault();
  dragDepth = 0;
  $("drop-zone").hidden = true;
  const files = [...event.dataTransfer.files];
  if (files.length) {
    if (state.filter === "trash") selectFilter("all");
    addFiles(files);
  }
});
async function showSettings() {
  closeSidebar(false);
  $("device-name").value = state.deviceName;
  resetPasswordForm();
  $("password-section").open = false;
  $("cleanup-error").textContent = "";
  $("cleanup-feedback").textContent = "";
  $("trash-retention").disabled = true;
  $("save-cleanup").disabled = true;
  $("settings-dialog").showModal();
  try {
    const settings = await api("/api/settings");
    $("trash-retention").value = String(settings.trashRetentionDays);
    $("trash-retention").disabled = false;
    $("save-cleanup").disabled = false;
  } catch (error) {
    $("cleanup-error").textContent = `读取设置失败：${error.message} 关闭设置后可重新打开重试。`;
  }
}
for (const id of ["settings-button", "settings-rail"])
  $(id).addEventListener("click", showSettings);
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => {
      const dialog = $(button.dataset.close);
      if (dialog.dataset.busy !== "true") dialog.close();
    }),
  );
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("cancel", (event) => {
    if (dialog.dataset.busy === "true") event.preventDefault();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog && dialog.dataset.busy !== "true") {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  });
}
function resetPasswordForm() {
  $("password-form").reset();
  for (const id of ["current-password", "new-password", "repeat-password"])
    $(id).type = "password";
  $("show-new-password").textContent = "显示密码";
  $("show-new-password").setAttribute("aria-pressed", "false");
  $("password-error").textContent = "";
  $("password-feedback").textContent = "";
}
$("settings-dialog").addEventListener("close", resetPasswordForm);
$("show-new-password").addEventListener("click", () => {
  const reveal = $("new-password").type === "password";
  for (const id of ["current-password", "new-password", "repeat-password"])
    $(id).type = reveal ? "text" : "password";
  $("show-new-password").textContent = reveal ? "隐藏密码" : "显示密码";
  $("show-new-password").setAttribute("aria-pressed", String(reveal));
});
$("password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("password-error").textContent = "";
  $("password-feedback").textContent = "";
  if ($("new-password").value !== $("repeat-password").value) {
    $("password-error").textContent = "两次输入的新密码不一致。";
    $("repeat-password").focus();
    return;
  }
  if (state.queue.some((item) => item.status === "uploading")) {
    $("password-error").textContent = "有文件正在上传，请完成或取消后再修改密码。";
    return;
  }
  const body = JSON.stringify({ currentPassword: $("current-password").value, newPassword: $("new-password").value });
  setDialogBusy("settings-dialog", true);
  $("save-password").textContent = "正在修改…";
  try {
    await api("/api/password", { method: "POST", body });
    resetPasswordForm();
    $("password-feedback").textContent = "密码已修改。其他设备需要用新密码重新登录。";
    if (state.active) connect();
  } catch (error) {
    $("password-error").textContent = error.message;
  } finally {
    setDialogBusy("settings-dialog", false);
    $("save-password").textContent = "修改密码";
    updateTrashSettings();
  }
});
// Remember individual disabled states (for example, an empty trash button).
function setDialogBusy(id, busy) {
  const dialog = $(id);
  dialog.dataset.busy = String(busy);
  dialog.setAttribute("aria-busy", String(busy));
  for (const control of dialog.querySelectorAll("input, select, button")) {
    if (busy) {
      control.dataset.wasDisabled = String(control.disabled);
      control.disabled = true;
    } else {
      control.disabled = control.dataset.wasDisabled === "true";
      delete control.dataset.wasDisabled;
    }
  }
}
$("cleanup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("cleanup-error").textContent = "";
  $("cleanup-feedback").textContent = "";
  const days = Number($("trash-retention").value);
  setDialogBusy("settings-dialog", true);
  $("save-cleanup").textContent = "正在保存…";
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ trashRetentionDays: days }) });
    state.stats.trashRetentionDays = days;
    $("cleanup-feedback").textContent = days
      ? `已保存。下次检查会清理删除满 ${days} 天的内容。`
      : "已关闭自动清理。最近删除会保留到手动清空。";
  } catch (error) {
    $("cleanup-error").textContent = error.message;
  } finally {
    setDialogBusy("settings-dialog", false);
    $("save-cleanup").textContent = "保存设置";
    updateTrashSettings();
  }
});
async function previewTrash() {
  if (state.purging) return;
  state.purging = true;
  updateTrashSettings();
  try {
    const preview = await api("/api/trash/preview");
    if (!preview.count) {
      state.stats.trash = 0;
      return;
    }
    state.trashPreview = preview;
    $("empty-trash-description").textContent = `将永久删除 ${preview.count} 条记录及其附件（${size(preview.bytes)}）。`;
    $("empty-trash-error").textContent = "";
    $("confirm-empty-trash").disabled = false;
    $("empty-trash-dialog").showModal();
  } catch (error) {
    if ($("settings-dialog").open) $("cleanup-error").textContent = error.message;
    else toast(error.message, true);
  } finally {
    state.purging = false;
    updateTrashSettings();
  }
}
for (const id of ["empty-trash", "settings-empty-trash"])
  $(id).addEventListener("click", previewTrash);
$("empty-trash-dialog").addEventListener("close", () => { state.trashPreview = null; });
$("empty-trash-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.trashPreview || state.purging) return;
  state.purging = true;
  setDialogBusy("empty-trash-dialog", true);
  $("confirm-empty-trash").textContent = "正在清空…";
  $("empty-trash-error").textContent = "";
  let stale = false;
  try {
    const result = await api("/api/trash/empty", { method: "POST", body: JSON.stringify({ confirm: true, token: state.trashPreview.token }) });
    $("empty-trash-dialog").close();
    const message = `已清空 ${result.deletedCount} 条记录。${result.pendingFiles ? "部分附件尚未释放空间，服务会自动重试。" : ""}`;
    if ($("settings-dialog").open) $("cleanup-feedback").textContent = message;
    else toast(message);
    await refreshAll();
  } catch (error) {
    stale = error.status === 409;
    $("empty-trash-error").textContent = stale
      ? `${error.message}请取消后重新打开清空窗口。`
      : error.message;
  } finally {
    state.purging = false;
    setDialogBusy("empty-trash-dialog", false);
    $("confirm-empty-trash").disabled = stale;
    $("confirm-empty-trash").textContent = "永久清空";
    updateTrashSettings();
  }
});
$("device-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = $("device-name").value.trim();
    await api("/api/devices", {
      method: "POST",
      body: JSON.stringify({ id: state.deviceId, name }),
    });
    state.deviceName = name;
    storage.set("device-name", name);
    $("composer-device").textContent = name;
    toast("设备名称已更新");
  } catch (error) {
    toast(error.message, true);
  }
});
$("logout").addEventListener("click", async () => {
  if (state.queue.some((i) => i.status === "uploading")) {
    toast("有文件正在上传，请完成或取消后再退出。", true);
    return;
  }
  try {
    await api("/api/logout", { method: "POST" });
    state.active = false;
    state.stream?.close();
    $("settings-dialog").close();
    showAuth();
  } catch (error) {
    toast(error.message, true);
  }
});
function closeSidebar(restoreFocus = true) {
  const wasOpen = $("sidebar").classList.contains("open");
  $("sidebar").classList.remove("open");
  $("sidebar-overlay").hidden = true;
  document.querySelector(".chat-main").inert = false;
  $("open-sidebar").setAttribute("aria-expanded", "false");
  if (wasOpen && restoreFocus && compactLayout.matches)
    $("open-sidebar").focus();
}
$("open-sidebar").addEventListener("click", () => {
  document.activeElement?.blur();
  $("sidebar").classList.add("open");
  $("sidebar-overlay").hidden = false;
  document.querySelector(".chat-main").inert = true;
  $("open-sidebar").setAttribute("aria-expanded", "true");
  $("close-sidebar").focus();
});
$("open-sidebar").setAttribute("aria-controls", "sidebar");
$("open-sidebar").setAttribute("aria-expanded", "false");
$("sidebar").addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || !compactLayout.matches) return;
  const buttons = [...$("sidebar").querySelectorAll("button")].filter(
    (button) => button.getClientRects().length && !button.disabled,
  );
  const first = buttons[0],
    last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});
$("close-sidebar").addEventListener("click", closeSidebar);
$("sidebar-overlay").addEventListener("click", closeSidebar);
document.addEventListener("keydown", (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "k" &&
    state.active
  ) {
    event.preventDefault();
    if (compactLayout.matches)
      document.querySelector(".chat-header").classList.add("searching");
    $("search").focus();
  }
  if (event.key === "Escape") {
    closeSidebar();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.active) refreshAll();
});
window.addEventListener("online", () => {
  if (state.active) {
    connect();
    refreshAll();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.queue.some((i) => i.status === "uploading")) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function boot() {
  icons();
  try {
    const status = await api("/api/status");
    state.initialized = status.initialized;
    state.stats = status;
    if (status.authenticated) await openWorkspace();
    else {
      showAuth();
      if (!status.initialized && !status.canSetup) {
        $("auth-error").textContent = "请先在运行程序的电脑上设置访问密码。";
        $("auth-submit").disabled = true;
      }
    }
  } catch (error) {
    $("boot").hidden = true;
    showAuth();
    $("auth-error").textContent =
      "无法连接本地服务，请确认程序已经启动后刷新。";
  }
}
if (matchMedia("(pointer:coarse)").matches)
  document.querySelector(".keyboard-hint").textContent = "回车换行，点击发送";
if (!/Mac|iPhone|iPad/.test(navigator.userAgent))
  document.querySelector(".search-shortcut").textContent = "Ctrl K";
boot();
