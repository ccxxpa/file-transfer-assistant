// Real-container release check; uses a fresh, disposable Docker volume.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2];
if (!image) throw new Error("Usage: node deploy/smoke-test.mjs IMAGE [REPORT.json]");
const context = process.env.DOCKER_CONTEXT || "default";
const upgradeFrom = process.env.UPGRADE_FROM;
const root = fileURLToPath(new URL("../", import.meta.url));
const fileHash = (relative) => createHash("sha256").update(readFileSync(path.join(root, relative))).digest("hex");
function filesIn(relative) {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(`${relative}/${entry.name}`) : [`${relative}/${entry.name}`]);
}
const name = `assistant-qa-${randomUUID().slice(0, 8)}`;
const volume = `${name}-data`;
const password = `test-only-${randomUUID()}`;
const deviceId = randomUUID();
let base, cookie = "", running = false;
const docker = (...args) => {
  const result = spawnSync("docker", ["--context", context, ...args], {
    encoding: "utf8", timeout: 90_000,
  });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
};
async function request(route, { method = "GET", body, raw = false, auth = true, sessionCookie = cookie } = {}) {
  return fetch(base + route, {
    method, signal: AbortSignal.timeout(15_000),
    headers: {
      "X-Assistant-Request": "1", "X-Device-Id": deviceId,
      "X-Request-Id": randomUUID(),
      ...(auth && sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
}
async function start(allowRemoteSetup, selectedImage = image) {
  docker("run", "-d", "--name", name, "--label", "app=file-transfer-assistant-qa",
    "--init", "--security-opt", "no-new-privileges:true",
    "--health-interval=1s", "--health-start-period=1s",
    "-p", "127.0.0.1::4826", "-v", `${volume}:/data`,
    "-e", `ALLOW_REMOTE_SETUP=${allowRemoteSetup}`, selectedImage);
  running = true;
  const state = JSON.parse(docker("inspect", name))[0];
  const port = state.NetworkSettings.Ports["4826/tcp"][0].HostPort;
  base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await request("/api/status")).ok) break; } catch {}
    await delay(250);
  }
  assert.equal((await request("/api/status")).status, 200);
}
function stop() {
  docker("stop", "--time", "30", name);
  assert.equal(JSON.parse(docker("inspect", name))[0].State.ExitCode, 0);
  docker("rm", name);
  running = false;
}
const report = { image, imageId: JSON.parse(docker("image", "inspect", image))[0].Id,
  checkedAt: new Date().toISOString(), checks: [] };
docker("volume", "create", "--label", "app=file-transfer-assistant-qa", volume);
try {
  await start(false);
  assert.equal((await (await request("/api/status")).json()).canSetup, false);
  assert.equal((await request("/api/setup", { method: "POST", body: { password } })).status, 403);
  report.checks.push("Remote initialization stays disabled unless explicitly enabled.");
  stop();
  await start(true, upgradeFrom || image);
  const fresh = await (await request("/api/status")).json();
  assert.equal(fresh.initialized, false);
  assert.equal(fresh.canSetup, true);
  assert.equal((await request("/api/messages", { auth: false })).status, 401);
  const setup = await request("/api/setup", { method: "POST", body: { password } });
  assert.equal(setup.status, 200);
  cookie = setup.headers.get("set-cookie").split(";")[0];
  assert.match(setup.headers.get("set-cookie"), /HttpOnly/);
  assert.equal((await request("/api/setup", { method: "POST", body: { password } })).status, 409);
  report.checks.push("Fresh volume, first password setup, authentication, and one-time setup lock.");
  assert.equal((await request("/api/devices", { method: "POST", body: { id: deviceId, name: "Docker 验收" } })).status, 200);
  assert.equal((await request("/api/messages", { method: "POST", body: { text: "Docker 持久化测试\n第二行", requestId: randomUUID() } })).status, 200);
  const bytes = Buffer.from("中文文件验收\n".repeat(4096));
  const form = new FormData();
  form.append("file", new Blob([bytes]), "中文 附件.txt");
  const upload = await request("/api/files", { method: "POST", body: form, raw: true });
  assert.equal(upload.status, 200);
  const attachment = await upload.json();
  assert.equal(attachment.fileName, "中文 附件.txt");
  report.checks.push("Text messages and Chinese file names upload successfully.");
  if (upgradeFrom) {
    stop();
    await start(true);
    assert.equal((await (await request("/api/status")).json()).authenticated, true);
    assert.equal((await (await request("/api/messages")).json()).messages.length, 2);
    assert.deepEqual(Buffer.from(await (await request(`/api/files/${attachment.id}`)).arrayBuffer()), bytes);
    report.upgradeFrom = upgradeFrom;
    report.checks.push("Upgrading the same volume from 1.0.0 retains the original session, history and attachments.");
  }
  report.sourceFiles = Object.fromEntries([
    "assistant/server.js", ...filesIn("assistant/public"), "package.json", "package-lock.json",
    "deploy/docker-entrypoint.sh", "deploy/healthcheck.js", "LICENSE", ...filesIn("licenses"),
  ].map((relative) => [relative, fileHash(relative)]));
  report.buildInputs = Object.fromEntries(["Dockerfile", ".dockerignore"].map((relative) => [relative, fileHash(relative)]));
  const containerFiles = JSON.parse(docker("exec", name, "node", "-e",
    "const fs=require('node:fs'),crypto=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));",
    JSON.stringify(Object.keys(report.sourceFiles))));
  assert.deepEqual(containerFiles, report.sourceFiles);
  report.checks.push("Every packaged application file matches the accepted local source byte for byte.");

  const settings = await (await request("/api/settings")).json();
  assert.equal(settings.trashRetentionDays, 7);
  assert.equal(settings.cleanupIntervalHours, 1);
  const oldCookie = cookie;
  const newPassword = `changed-test-only-${randomUUID()}`;
  assert.equal((await request("/api/password", { method: "POST", body: { currentPassword: "wrong", newPassword } })).status, 403);
  const changed = await request("/api/password", { method: "POST", body: { currentPassword: password, newPassword } });
  assert.equal(changed.status, 200);
  cookie = changed.headers.get("set-cookie").split(";")[0];
  assert.notEqual(cookie, oldCookie);
  assert.equal((await request("/api/stats", { sessionCookie: oldCookie })).status, 401);
  assert.equal((await request("/api/stats")).status, 200);
  assert.equal((await request("/api/login", { method: "POST", auth: false, body: { password } })).status, 401);
  report.checks.push("Password change validates the current password, replaces the current session and invalidates old credentials.");

  const trashFile = async (text) => {
    const form = new FormData();
    form.append("file", new Blob([text]), "待清理.txt");
    const response = await request("/api/files", { method: "POST", body: form, raw: true });
    assert.equal(response.status, 200);
    const item = await response.json();
    assert.equal((await request(`/api/messages/${item.id}`, { method: "PATCH", body: { deleted: true } })).status, 200);
    return item;
  };
  const removed = await trashFile("manual cleanup fixture");
  const preview = await (await request("/api/trash/preview")).json();
  assert.equal(preview.count, 1);
  await trashFile("second manual cleanup fixture");
  assert.equal((await request("/api/trash/empty", { method: "POST", body: { confirm: true, token: preview.token } })).status, 409);
  const freshPreview = await (await request("/api/trash/preview")).json();
  assert.equal(freshPreview.count, 2);
  const emptied = await request("/api/trash/empty", { method: "POST", body: { confirm: true, token: freshPreview.token } });
  assert.equal(emptied.status, 200);
  assert.deepEqual(await emptied.json(), { deletedCount: 2, pendingFiles: 0 });
  assert.equal((await request(`/api/messages/${removed.id}`, { method: "PATCH", body: { deleted: false } })).status, 404);
  assert.equal((await (await request("/api/stats")).json()).usedBytes, bytes.length);
  assert.equal(Number(docker("exec", name, "node", "-e", "console.log(require('node:fs').readdirSync('/data/files').length)")), 1);
  report.checks.push("Manual empty detects stale confirmation, removes deleted records and files, and protects active history.");

  assert.equal((await request("/api/settings", { method: "PUT", body: { trashRetentionDays: 30 } })).status, 200);
  const expired = await trashFile("scheduled cleanup fixture");
  // Only age synthetic data in this disposable test volume, never user data.
  docker("exec", "--user", "1000:1000", name, "node", "-e",
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/assistant.sqlite');db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').run(Date.now()-8*864e5,Number(process.argv[1]));db.close();", String(expired.id));
  const runtime = JSON.parse(docker("exec", name, "node", "-e",
    "const fs=require('node:fs');const pid=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)&&p!=='1').find(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('/app/assistant/server.js')}catch{return false}});const uid=Number(fs.readFileSync('/proc/'+pid+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1]);console.log(JSON.stringify({appUid:uid,arch:process.arch,node:process.version,privatePaths:['/app/data','/app/.local','/app/.git','/app/assistant/test'].filter(p=>fs.existsSync(p))}));"));
  assert.equal(runtime.appUid, 1000);
  assert.deepEqual(runtime.privatePaths, []);
  report.runtime = runtime;
  docker("exec", name, "node", "/app/deploy/healthcheck.js");
  report.checks.push("Node runs as UID 1000; no development data, Git metadata or test fixtures in image; health check passes.");
  const events = await fetch(`${base}/api/events?deviceId=${deviceId}`, { headers: { Cookie: cookie } });
  const reader = events.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /presence/);
  const stoppingAt = Date.now();
  stop();
  report.stopMillisecondsWithSSE = Date.now() - stoppingAt;
  assert.ok(report.stopMillisecondsWithSSE < 10_000);
  await reader.cancel().catch(() => {});
  await start(true);
  assert.equal((await (await request("/api/status")).json()).authenticated, true);
  const messages = await (await request("/api/messages")).json();
  assert.equal(messages.messages.length, 2);
  const download = await request(`/api/files/${attachment.id}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await request(`/api/files/${attachment.id}`, { auth: false })).status, 401);
  const login = await request("/api/login", { method: "POST", auth: false, body: { password: newPassword } });
  assert.equal(login.status, 200);
  report.fileSHA256 = createHash("sha256").update(bytes).digest("hex");
  report.checks.push("Recreated container retains password, session, messages and byte-identical attachment in persistent volume.");
  report.checks.push("SSE closes gracefully on stop; container exits with code 0.");
  assert.equal((await (await request("/api/settings")).json()).trashRetentionDays, 30);
  assert.equal((await (await request("/api/trash/preview")).json()).count, 1);
  assert.equal((await request("/api/settings", { method: "PUT", body: { trashRetentionDays: 7 } })).status, 200);
  stop();
  await start(true);
  const cleanupDeadline = Date.now() + 5000;
  let remaining;
  do {
    remaining = (await (await request("/api/trash/preview")).json()).count;
    if (remaining) await delay(100);
  } while (remaining && Date.now() < cleanupDeadline);
  assert.equal(remaining, 0);
  assert.equal((await (await request("/api/settings")).json()).trashRetentionDays, 7);
  assert.equal((await (await request("/api/stats")).json()).usedBytes, bytes.length);
  assert.equal(Number(docker("exec", name, "node", "-e", "console.log(require('node:fs').readdirSync('/data/files').length)")), 1);
  assert.deepEqual(Buffer.from(await (await request(`/api/files/${attachment.id}`)).arrayBuffer()), bytes);
  report.checks.push("Cleanup policy persists across recreation; startup removes eight-day-old trash only under the seven-day policy and frees disk space.");
  for (const route of ["/", "/style.css", "/app.js", "/viewport.js", "/vendor/lucide.js"])
    assert.equal((await request(route)).status, 200);
  report.checks.push("All local frontend assets served successfully.");
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3]) {
    mkdirSync(new URL("../.local/", import.meta.url), { recursive: true });
    writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n");
  }
} finally {
  if (running) stop();
  docker("volume", "rm", volume);
}
