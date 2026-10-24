import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createAssistant } from "../server.js";

const password = "local-test-password-2026";
const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t, options = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "file-assistant-test-"));
  let instance, server;
  const start = async () => {
    instance = createAssistant({ dataDir, ...options });
    server = instance.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  const f = {
    dataDir,
    base: await start(),
    cookie: "",
    deviceId: randomUUID(),
    db: () => instance.db,
    cleanup: (now) => instance.runCleanup(now),
  };
  const stop = async () => {
    instance.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  f.restart = async () => {
    await stop();
    f.base = await start();
  };
  f.request = async (
    route,
    {
      method = "GET",
      body,
      headers = {},
      cookie = f.cookie,
      device = f.deviceId,
      raw = false,
    } = {},
  ) => {
    const response = await fetch(f.base + route, {
      method,
      headers: {
        "X-Assistant-Request": "1",
        "X-Device-Id": device,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body && !raw ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    return response;
  };
  f.setup = async () => {
    const response = await f.request("/api/setup", {
      method: "POST",
      body: { password },
    });
    assert.equal(response.status, 200);
    f.cookie = response.headers.get("set-cookie").split(";")[0];
    await f.register();
  };
  f.register = async (id = f.deviceId, name = "测试 Mac") => {
    const response = await f.request("/api/devices", {
      method: "POST",
      body: { id, name },
    });
    assert.equal(response.status, 200);
  };
  f.send = async (text, requestId = randomUUID(), device = f.deviceId) => {
    const response = await f.request("/api/messages", {
      method: "POST",
      body: { text, requestId },
      device,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  f.upload = async (
    content,
    name = "文件.txt",
    type = "text/plain",
    requestId = randomUUID(),
  ) => {
    const form = new FormData();
    form.append("file", new Blob([content], { type }), name);
    return f.request("/api/files", {
      method: "POST",
      body: form,
      raw: true,
      headers: { "X-Request-Id": requestId },
    });
  };
  t.after(async () => {
    await stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return f;
}

const trash = (f, id, deleted = true) => f.request(`/api/messages/${id}`, {
  method: "PATCH", body: { deleted },
});
const setRetention = (f, days) => f.request("/api/settings", {
  method: "PUT", body: { trashRetentionDays: days },
});
const previewTrash = async (f) => (await f.request("/api/trash/preview")).json();
const emptyTrash = async (f, preview) => f.request("/api/trash/empty", {
  method: "POST", body: { confirm: true, token: (preview || await previewTrash(f)).token },
});

const batchMessages = (f, ids, deleted = true) => f.request("/api/messages/batch", {
  method: "PATCH", body: { ids, deleted },
});

test("date cleanup selects a whole local calendar day beyond a page and preserves exact boundaries", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const start = Date.parse("2026-10-08T00:00:00+08:00");
  const until = Date.parse("2026-10-09T00:00:00+08:00");
  const stamp = (id, value) => f.db().prepare("UPDATE messages SET created_at=? WHERE id=?").run(value, id);
  const prior = await f.send("前一天最后一毫秒");
  stamp(prior.id, start - 1);
  const dayIds = [];
  for (let i = 0; i < 65; i++) {
    const item = await f.send(`当天 ${i}`);
    stamp(item.id, i === 64 ? until - 1 : start + i);
    dayIds.push(item.id);
  }
  const file = await (await f.upload("date cleanup payload", "当天附件.txt")).json();
  stamp(file.id, start + 1000);
  const next = await f.send("第二天零点");
  stamp(next.id, until);
  const alreadyDeleted = await f.send("当天已删除");
  stamp(alreadyDeleted.id, start + 2000);
  await trash(f, alreadyDeleted.id);
  const query = new URLSearchParams({ from: String(start), until: String(until) });
  const selection = await (await f.request(`/api/messages/selection?${query}`)).json();
  assert.deepEqual(selection.ids, [...dayIds, file.id]);
  assert.equal(selection.bytes, Buffer.byteLength("date cleanup payload"));
  const page = await (await f.request(`/api/messages?${query}`)).json();
  assert.equal(page.messages.length, 60);
  assert.equal(page.hasMore, true);
  assert.deepEqual((await (await f.request(`/api/messages/selection?until=${start}`)).json()).ids, [prior.id]);
  assert.deepEqual((await (await f.request(`/api/messages/selection?${query}&kind=file&q=附件`)).json()).ids, [file.id]);
  assert.deepEqual((await (await f.request(`/api/messages/selection?${query}&trash=1`)).json()).ids, [alreadyDeleted.id]);
  assert.deepEqual(await (await batchMessages(f, selection.ids)).json(), { changedCount: 66 });
  assert.deepEqual((await (await f.request("/api/messages/selection")).json()).ids, [prior.id, next.id]);
  await batchMessages(f, selection.ids, false);
  assert.equal(await (await f.request(`/api/files/${file.id}`)).text(), "date cleanup payload");
});

test("date ranges accept timezone-aware day bounds and reject malformed or reversed ranges", async (t) => {
  const f = await fixture(t);
  await f.setup();
  // DST spring-forward day is 23 hours; the following calendar day must stay out.
  const from = Date.parse("2026-03-08T00:00:00-05:00");
  const until = Date.parse("2026-03-09T00:00:00-04:00");
  assert.equal(until - from, 23 * 3600e3);
  const included = await f.send("last instant"), excluded = await f.send("next day");
  f.db().prepare("UPDATE messages SET created_at=? WHERE id=?").run(until - 1, included.id);
  f.db().prepare("UPDATE messages SET created_at=? WHERE id=?").run(until, excluded.id);
  assert.deepEqual((await (await f.request(`/api/messages/selection?from=${from}&until=${until}`)).json()).ids, [included.id]);
  for (const query of ["from=bad", "from=", "until=NaN", "until=1.5", "from[]=1", "from=1&from=2", "until=8640000000000001", "from=2&until=1", "from=1&until=1"])
    assert.equal((await f.request(`/api/messages/selection?${query}`)).status, 400, query);
  assert.equal((await f.request("/api/messages?from=bad")).status, 400);
  assert.equal((await f.request(`/api/messages/selection?from=${from}&until=${until}`, { cookie: "" })).status, 401);
  assert.equal((await (await f.request("/api/messages/selection")).json()).ids.length, 2);
});

test("bulk selection follows search/type/trash filters beyond one page and freezes the selected IDs", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const selected = [];
  for (let i = 0; i < 65; i++) selected.push((await f.send(`待清理 100%_ ${i}`)).id);
  const keep = await f.send("待清理 100XA 不匹配字面搜索");
  const file = await (await f.upload("kept attachment", "待清理 100%_.txt")).json();
  const discarded = await f.send("待清理 100%_ 已删除");
  await trash(f, discarded.id);
  const query = new URLSearchParams({ kind: "text", q: "待清理 100%_" });
  const page = await (await f.request(`/api/messages?${query}`)).json();
  assert.equal(page.messages.length, 60);
  assert.equal(page.hasMore, true);
  const selection = await (await f.request(`/api/messages/selection?${query}`)).json();
  assert.deepEqual(selection.ids, selected);
  const newest = await f.send("待清理 100%_ 选完后新到的消息");
  const result = await batchMessages(f, selection.ids);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { changedCount: 65 });
  const active = await (await f.request("/api/messages/selection")).json();
  assert.deepEqual(active.ids, [keep.id, file.id, newest.id]);
  const deleted = await (await f.request(`/api/messages/selection?${query}&trash=1`)).json();
  assert.deepEqual(deleted.ids, [...selected, discarded.id]);
  assert.equal((await f.request(`/api/files/${file.id}`)).status, 200);
});

test("batch delete and restore preserve attachments, accept unique IDs only once, and persist", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const file = await (await f.upload("recoverable payload")).json();
  const text = await f.send("recover me");
  const originalBytes = (await (await f.request("/api/stats")).json()).usedBytes;
  assert.deepEqual(await (await batchMessages(f, [file.id, text.id, file.id])).json(), { changedCount: 2 });
  assert.equal((await f.request(`/api/files/${file.id}`)).status, 404);
  assert.equal((await (await f.request("/api/stats")).json()).usedBytes, originalBytes);
  await f.restart();
  assert.deepEqual(await (await batchMessages(f, [file.id, text.id], false)).json(), { changedCount: 2 });
  assert.equal(await (await f.request(`/api/files/${file.id}`)).text(), "recoverable payload");
  assert.equal((await (await f.request("/api/messages?trash=1")).json()).messages.length, 0);
});

test("stale bulk requests make no partial changes or reset a deletion's retention clock", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const first = await f.send("first"), second = await f.send("second");
  await trash(f, second.id);
  const stamp = f.db().prepare("SELECT deleted_at FROM messages WHERE id=?").get(second.id).deleted_at;
  for (const ids of [[first.id, second.id], [first.id, 99999]]) {
    assert.equal((await batchMessages(f, ids)).status, 409);
    assert.equal(f.db().prepare("SELECT deleted_at FROM messages WHERE id=?").get(first.id).deleted_at, null);
    assert.equal(f.db().prepare("SELECT deleted_at FROM messages WHERE id=?").get(second.id).deleted_at, stamp);
  }
  assert.equal((await batchMessages(f, [first.id, second.id], false)).status, 409);
  assert.equal(f.db().prepare("SELECT deleted_at FROM messages WHERE id=?").get(second.id).deleted_at, stamp);
});

test("bulk operations require authentication, same origin, and a bounded valid ID list", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/messages/selection")).status, 401);
  assert.equal((await batchMessages(f, [1])).status, 401);
  await f.setup();
  const item = await f.send("keep");
  assert.equal((await f.request("/api/messages/batch", {
    method: "PATCH", body: { ids: [item.id], deleted: true }, headers: { Origin: "https://other.invalid" },
  })).status, 403);
  for (const ids of [[], "all", [0], [-1], ["1"], [null], [1.1], [Number.MAX_SAFE_INTEGER + 1], Array(10001).fill(item.id)])
    assert.equal((await batchMessages(f, ids)).status, 400);
  assert.equal((await batchMessages(f, [item.id], "true")).status, 400);
  assert.equal(f.db().prepare("SELECT deleted_at FROM messages WHERE id=?").get(item.id).deleted_at, null);
});

test("password change verifies current password, revokes other sessions and SSE, and survives restart", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const originalCookie = f.cookie;
  const second = await f.request("/api/login", { method: "POST", body: { password } });
  const otherCookie = second.headers.get("set-cookie").split(";")[0];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(f.base + "/api/events?deviceId=" + f.deviceId, {
    headers: { Cookie: otherCookie }, signal: controller.signal,
  });
  const reader = events.body.getReader();
  await reader.read();
  const nextPassword = "new-test-password-2026";
  const change = (currentPassword, newPassword, cookie = f.cookie) => f.request("/api/password", {
    method: "POST", body: { currentPassword, newPassword }, cookie,
  });
  assert.equal((await change(password, nextPassword, "")).status, 401);
  assert.equal((await change("incorrect", nextPassword)).status, 403);
  assert.equal((await change(password, "short")).status, 400);
  assert.equal((await change(password, password)).status, 400);
  assert.equal((await f.request("/api/stats", { cookie: otherCookie })).status, 200);
  const changed = await change(password, nextPassword);
  assert.equal(changed.status, 200);
  f.cookie = changed.headers.get("set-cookie").split(";")[0];
  assert.notEqual(f.cookie, originalCookie);
  let eventText = "";
  while (!eventText.includes("session-revoked")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    eventText += new TextDecoder().decode(chunk.value);
  }
  assert.match(eventText, /session-revoked/);
  controller.abort();
  await reader.cancel().catch(() => {});
  for (const cookie of [originalCookie, otherCookie])
    assert.equal((await f.request("/api/stats", { cookie })).status, 401);
  assert.equal(f.db().prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
  assert.equal((await f.request("/api/stats")).status, 200);
  await f.restart();
  assert.equal((await f.request("/api/stats")).status, 200);
  assert.equal((await f.request("/api/login", { method: "POST", body: { password } })).status, 401);
  assert.equal((await f.request("/api/login", { method: "POST", body: { password: nextPassword } })).status, 200);
});

test("concurrent password changes cannot overwrite a successful change with stale credentials", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const candidates = ["next-password-one", "next-password-two"];
  const results = await Promise.all(candidates.map((newPassword) => f.request("/api/password", {
    method: "POST", body: { currentPassword: password, newPassword },
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  for (let i = 0; i < candidates.length; i++) {
    const login = await f.request("/api/login", { method: "POST", body: { password: candidates[i] } });
    assert.equal(login.status, results[i].status === 200 ? 200 : 401);
  }
});

test("trash settings require authentication, validate options and persist the seven-day default or disabled choice", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/settings")).status, 401);
  assert.equal((await f.request("/api/trash/preview")).status, 401);
  assert.equal((await f.request("/api/trash/empty", { method: "POST", body: {} })).status, 401);
  await f.setup();
  const initial = await (await f.request("/api/settings")).json();
  assert.equal(initial.trashRetentionDays, 7);
  assert.equal(initial.cleanupIntervalHours, 1);
  for (const invalid of [-1, 2, 3.5, "7", null])
    assert.equal((await setRetention(f, invalid)).status, 400);
  assert.equal((await f.request("/api/settings", {
    method: "PUT", body: { trashRetentionDays: 1 }, headers: { Origin: "https://other.invalid" },
  })).status, 403);
  for (const days of [1, 7, 30, 90, 0]) {
    assert.equal((await setRetention(f, days)).status, 200);
    assert.equal((await (await f.request("/api/settings")).json()).trashRetentionDays, days);
  }
  await f.restart();
  assert.equal((await (await f.request("/api/settings")).json()).trashRetentionDays, 0);
});

test("manual empty requires a current preview, removes all trash beyond a page and frees only deleted attachments", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const keep = await (await f.upload("keep this active file")).json();
  const discarded = await (await f.upload("discard this file")).json();
  await trash(f, discarded.id);
  const oldPreview = await previewTrash(f);
  assert.equal(oldPreview.count, 1);
  assert.equal(oldPreview.bytes, Buffer.byteLength("discard this file"));
  assert.equal((await f.request("/api/trash/empty", { method: "POST", body: { token: oldPreview.token } })).status, 400);
  for (let i = 0; i < 62; i++) await trash(f, (await f.send(`discard ${i}`)).id);
  assert.equal((await emptyTrash(f, oldPreview)).status, 409);
  assert.equal((await previewTrash(f)).count, 63);
  const result = await (await emptyTrash(f)).json();
  assert.deepEqual(result, { deletedCount: 63, pendingFiles: 0 });
  assert.equal((await previewTrash(f)).count, 0);
  assert.equal((await f.request(`/api/files/${discarded.id}`)).status, 404);
  assert.equal((await trash(f, discarded.id, false)).status, 404);
  assert.equal(await (await f.request(`/api/files/${keep.id}`)).text(), "keep this active file");
  assert.equal(readdirSync(path.join(f.dataDir, "files")).length, 1);
  assert.equal((await (await f.request("/api/stats")).json()).usedBytes, keep.size);
  assert.equal((await (await emptyTrash(f)).json()).deletedCount, 0);
});

test("retention uses deletion time, includes the exact boundary, protects restored/active records and can be disabled", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const now = Date.now();
  const cutoff = now - 7 * 864e5;
  const expired = await (await f.upload("old trash")).json();
  const boundary = await f.send("at boundary");
  const recent = await f.send("just inside retention");
  const restored = await (await f.upload("restored file")).json();
  const active = await f.send("old active message");
  for (const item of [expired, boundary, recent, restored]) await trash(f, item.id);
  const age = (id, when) => f.db().prepare("UPDATE messages SET deleted_at=?, created_at=? WHERE id=?").run(when, now - 365 * 864e5, id);
  age(expired.id, cutoff - 1);
  age(boundary.id, cutoff);
  age(recent.id, cutoff + 1);
  age(restored.id, cutoff - 1000);
  age(active.id, null);
  await trash(f, restored.id, false);
  await setRetention(f, 0);
  assert.equal((await f.cleanup(now)).deletedCount, 0);
  await setRetention(f, 7);
  assert.equal((await f.cleanup(now)).deletedCount, 2);
  assert.deepEqual((await (await f.request("/api/messages?trash=1")).json()).messages.map((m) => m.id), [recent.id]);
  assert.equal(await (await f.request(`/api/files/${restored.id}`)).text(), "restored file");
  assert.equal((await (await f.request("/api/messages")).json()).messages.length, 2);
  assert.equal((await f.cleanup(now)).deletedCount, 0);
  await trash(f, recent.id, false);
  await trash(f, recent.id);
  assert.equal((await f.cleanup(now + 864e5)).deletedCount, 0);
  assert.equal((await (await f.request("/api/settings")).json()).lastCleanupAt, now + 864e5);
});

test("file deletion failure keeps accounted bytes and a retry journal that survives restart", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const content = "retry file removal";
  const item = await (await f.upload(content)).json();
  const key = f.db().prepare("SELECT file_key FROM messages WHERE id=?").get(item.id).file_key;
  const file = path.join(f.dataDir, "files", key);
  rmSync(file);
  mkdirSync(file); // Deterministic unlink failure, even when tests run as root.
  await trash(f, item.id);
  const result = await (await emptyTrash(f)).json();
  assert.deepEqual(result, { deletedCount: 1, pendingFiles: 1 });
  assert.equal((await (await f.request("/api/stats")).json()).usedBytes, item.size);
  await setRetention(f, 0);
  await f.restart();
  assert.equal((await (await f.request("/api/settings")).json()).pendingDeletionFiles, 1);
  rmSync(file, { recursive: true });
  writeFileSync(file, content);
  assert.deepEqual(await f.cleanup(), { deletedCount: 0, pendingFiles: 0 });
  assert.equal(existsSync(file), false);
  assert.equal((await (await f.request("/api/stats")).json()).usedBytes, 0);
});

test("startup catches up on expired trash after downtime without a browser visit", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const item = await f.send("expired while server was off");
  await trash(f, item.id);
  f.db().prepare("UPDATE messages SET deleted_at=? WHERE id=?").run(Date.now() - 8 * 864e5, item.id);
  await f.restart();
  const deadline = Date.now() + 4000;
  while (f.db().prepare("SELECT COUNT(*) AS n FROM messages").get().n && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.db().prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
  assert.ok((await (await f.request("/api/settings")).json()).lastCleanupAt);
});

test("first setup, authentication, cross-origin rejection, logout invalidation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/messages")).status, 401);
  assert.equal(
    (
      await f.request("/api/setup", {
        method: "POST",
        body: { password: "123" },
      })
    ).status,
    400,
  );
  await f.setup();
  assert.equal((await f.request("/api/status")).status, 200);
  assert.equal(
    (await f.request("/api/setup", { method: "POST", body: { password } }))
      .status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        body: { password: "incorrect" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/messages", {
        method: "POST",
        body: { text: "injected", requestId: randomUUID() },
        headers: { Origin: "https://other.invalid" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/messages", {
        method: "POST",
        body: { text: "injected", requestId: randomUUID() },
        headers: { "X-Assistant-Request": "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/logout", { method: "POST" })).status,
    200,
  );
  assert.equal((await f.request("/api/messages")).status, 401);
  const login = await f.request("/api/login", {
    method: "POST",
    body: { password },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
});

test("cross-device shared history, exact text, retry idempotency, literal search and pagination", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const device2 = randomUUID();
  await f.register(device2, "测试手机");
  const text =
    "第一行\n<script>alert(1)</script>\nhttps://example.com/ 100% _保留";
  const requestId = randomUUID();
  const sent = await f.send(text, requestId);
  assert.equal((await f.send(text, requestId)).id, sent.id);
  const second = await f.send("来自手机的消息", randomUUID(), device2);
  assert.equal(second.deviceName, "测试手机");
  assert.equal(
    (
      await (
        await f.request("/api/messages?q=" + encodeURIComponent("100% _"))
      ).json()
    ).messages[0].text,
    text,
  );
  assert.equal(
    (
      await (
        await f.request("/api/messages?q=" + encodeURIComponent("' OR 1=1 --"))
      ).json()
    ).messages.length,
    0,
  );
  for (let i = 0; i < 63; i++) await f.send("分页 " + i);
  const page1 = await (await f.request("/api/messages")).json();
  assert.equal(page1.messages.length, 60);
  assert.equal(page1.hasMore, true);
  const page2 = await (
    await f.request("/api/messages?before=" + page1.messages[0].id)
  ).json();
  assert.equal(page2.messages.length, 5);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.messages[0].text, text);
});

test("file bytes and Chinese filename survive server restart; image types are sniffed", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const requestId = randomUUID();
  const content = Buffer.from("文件内容保持原样\n\0binary", "utf8");
  const upload = await f.upload(
    content,
    "中文 文件.txt",
    "text/plain",
    requestId,
  );
  assert.equal(upload.status, 200);
  const message = await upload.json();
  assert.equal(message.fileName, "中文 文件.txt");
  assert.equal(message.kind, "file");
  const duplicate = await (
    await f.upload(content, "中文 文件.txt", "text/plain", requestId)
  ).json();
  assert.equal(duplicate.id, message.id);
  const image = await (
    await f.upload(fixturePng, "测试截图.png", "image/png")
  ).json();
  assert.equal(image.kind, "image");
  const hostile = await (
    await f.upload('<svg onload="alert(1)"></svg>', "unsafe.svg", "image/png")
  ).json();
  assert.equal(hostile.kind, "file");
  await f.restart();
  const downloaded = await f.request("/api/files/" + message.id);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
  assert.match(downloaded.headers.get("content-disposition"), /UTF-8''/);
  const preview = await f.request("/api/files/" + image.id + "?preview=1");
  assert.match(preview.headers.get("content-type"), /image\/png/);
  const unsafe = await f.request("/api/files/" + hostile.id + "?preview=1");
  assert.match(unsafe.headers.get("content-type"), /application\/octet-stream/);
  assert.match(unsafe.headers.get("content-disposition"), /attachment/);
  assert.equal(
    (await f.request("/api/files/" + message.id, { cookie: "" })).status,
    401,
  );
});

test("soft delete hides download and history, restore returns both", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const message = await (await f.upload("recover me")).json();
  const patch = (deleted) =>
    f.request("/api/messages/" + message.id, {
      method: "PATCH",
      body: { deleted },
    });
  assert.equal((await patch(true)).status, 200);
  assert.equal((await f.request("/api/files/" + message.id)).status, 404);
  assert.equal(
    (await (await f.request("/api/messages")).json()).messages.length,
    0,
  );
  assert.equal(
    (await (await f.request("/api/messages?trash=1")).json()).messages[0].id,
    message.id,
  );
  assert.equal((await patch(false)).status, 200);
  assert.equal(
    await (await f.request("/api/files/" + message.id)).text(),
    "recover me",
  );
});

test("file and total capacity limits leave no partial history or files", async (t) => {
  const f = await fixture(t, { maxFileBytes: 1024, maxStorageBytes: 1500 });
  await f.setup();
  assert.equal((await f.upload(Buffer.alloc(2048))).status, 413);
  assert.equal((await f.upload(Buffer.alloc(900))).status, 200);
  assert.equal((await f.upload(Buffer.alloc(800))).status, 413);
  assert.equal(
    (await (await f.request("/api/messages")).json()).messages.length,
    1,
  );
  assert.equal((await (await f.request("/api/stats")).json()).usedBytes, 900);
  assert.equal(readdirSync(path.join(f.dataDir, "tmp")).length, 0);
  assert.equal(readdirSync(path.join(f.dataDir, "files")).length, 1);
});

test("real-time events carry live device presence and message changes", async (t) => {
  const f = await fixture(t);
  await f.setup();
  const controller = new AbortController();
  const response = await fetch(f.base + "/api/events?deviceId=" + f.deviceId, {
    headers: { Cookie: f.cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /presence/);
  await f.send("测试实时同步");
  const change = await reader.read();
  assert.match(new TextDecoder().decode(change.value), /change/);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test("frontend assets served locally; secrets and data directories are not served", async (t) => {
  const f = await fixture(t);
  for (const route of ["/", "/app.js", "/style.css", "/vendor/lucide.js"])
    assert.equal((await fetch(f.base + route)).status, 200);
  for (const route of [
    "/data/assistant.sqlite",
    "/assistant/server.js",
    "/.git/config",
  ])
    assert.equal((await fetch(f.base + route)).status, 404);
  const response = await fetch(f.base);
  assert.match(
    response.headers.get("content-security-policy"),
    /object-src 'none'/,
  );
  assert.match(
    readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    /escapeHtml\(message\.fileName\)/,
  );
});
