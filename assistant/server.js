import express from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import {
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { unlink as removeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const hashPassword = promisify(scrypt);
const root = path.dirname(fileURLToPath(import.meta.url));
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (res, code, message) => res.status(code).json({ error: message });
const validId = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(id);
const loopback = (ip) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);

export function createAssistant({
  dataDir = process.env.DATA_DIR || path.join(root, "../data"),
  allowRemoteSetup = process.env.ALLOW_REMOTE_SETUP === "true",
  maxFileBytes = Number(process.env.MAX_FILE_MB || 100) * 1024 ** 2,
  maxStorageBytes = Number(process.env.MAX_STORAGE_MB || 5120) * 1024 ** 2,
} = {}) {
  dataDir = path.resolve(dataDir);
  const filesDir = path.join(dataDir, "files");
  const tmpDir = path.join(dataDir, "tmp");
  for (const dir of [dataDir, filesDir, tmpDir])
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "assistant.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL,
      device_id TEXT NOT NULL, device_name TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', file_name TEXT, file_key TEXT, mime TEXT,
      size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS messages_timeline ON messages(deleted_at, id);`);
  db.exec(`CREATE TABLE IF NOT EXISTS pending_deletions (
    file_key TEXT PRIMARY KEY, size INTEGER NOT NULL
  );`);
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
  const getSetting = (key) =>
    db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
  const usedBytes = () =>
    Number(
      db.prepare(`SELECT (SELECT COALESCE(SUM(size), 0) FROM messages) +
        (SELECT COALESCE(SUM(size), 0) FROM pending_deletions) AS size`).get().size,
    );
  const streams = new Map();
  const reserved = new Set();
  const cleanupIntervalMs = 60 * 60e3;
  const retentionDays = () => Number(getSetting("trash_retention_days") ?? 7);
  const pendingFiles = () => db.prepare("SELECT COUNT(*) AS n FROM pending_deletions").get().n;
  let fileCleanup;
  let closed = false;
  async function flushDeletedFiles() {
    if (fileCleanup) return fileCleanup;
    fileCleanup = (async () => {
      for (const row of db.prepare("SELECT file_key FROM pending_deletions").all()) {
        if (closed) return;
        try {
          if (path.basename(row.file_key) !== row.file_key) throw new Error("Invalid file key");
          await removeFile(path.join(filesDir, row.file_key)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
          if (closed) return;
          db.prepare("DELETE FROM pending_deletions WHERE file_key=?").run(row.file_key);
        } catch (error) {
          console.error("File cleanup will retry:", error.code || error.name);
        }
      }
    })().finally(() => { fileCleanup = null; });
    return fileCleanup;
  }
  function trashSnapshot() {
    const rows = db.prepare("SELECT id, deleted_at, size FROM messages WHERE deleted_at IS NOT NULL ORDER BY id").all();
    return {
      count: rows.length,
      bytes: rows.reduce((sum, row) => sum + row.size, 0),
      token: digest(JSON.stringify(rows)),
    };
  }
  function enqueuePurge(cutoff) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT OR IGNORE INTO pending_deletions (file_key, size)
        SELECT file_key, size FROM messages
        WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND file_key IS NOT NULL`).run(cutoff);
      const count = Number(db.prepare("DELETE FROM messages WHERE deleted_at IS NOT NULL AND deleted_at <= ?").run(cutoff).changes);
      db.exec("COMMIT");
      return count;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  async function runCleanup(now = Date.now()) {
    if (closed) return;
    const days = retentionDays();
    const deletedCount = days ? enqueuePurge(now - days * 864e5) : 0;
    await flushDeletedFiles();
    if (closed) return;
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('last_cleanup_at', ?)").run(String(now));
    broadcast({ type: "change" });
    return { deletedCount, pendingFiles: pendingFiles() };
  }
  const publicMessage = (row) => ({
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    kind: row.kind,
    text: row.text,
    fileName: row.file_name,
    mime: row.mime,
    size: row.size,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.get("X-Assistant-Request") !== "1")
        return fail(res, 403, "请求来源无效，请刷新页面后重试。");
      if (req.get("Origin")) {
        try {
          if (new URL(req.get("Origin")).host !== req.get("Host"))
            return fail(res, 403, "不允许其他网站提交请求。");
        } catch {
          return fail(res, 403, "请求来源无效。");
        }
      }
    }
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  function session(req) {
    const token = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("assistant_session="))
      ?.slice(18);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const found = db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires > ?")
      .get(digest(token), Date.now());
    return found || null;
  }
  function auth(req, res, next) {
    req.session = session(req);
    if (!req.session) return fail(res, 401, "请先登录文件传输助手。");
    next();
  }
  function issueSession(req, res) {
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
      digest(token),
      Date.now() + 30 * 864e5,
    );
    res.cookie("assistant_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: 30 * 864e5,
      path: "/",
    });
  }
  const authLimit = rateLimit({
    windowMs: 15 * 60e3,
    limit: 15,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "尝试次数过多，请 15 分钟后重试。" },
  });
  let settingUp = false;
  const canSetup = (req) => allowRemoteSetup || loopback(req.socket.remoteAddress);
  app.get("/api/status", (req, res) =>
    res.json({
      initialized: !!getSetting("password"),
      authenticated: !!session(req),
      canSetup: canSetup(req),
      maxFileBytes,
      maxStorageBytes,
    }),
  );
  app.post(
    "/api/setup",
    authLimit,
    asyncRoute(async (req, res) => {
      if (!canSetup(req))
        return fail(res, 403, "请先在运行程序的电脑上设置访问密码。");
      if (getSetting("password") || settingUp)
        return fail(res, 409, "已完成设置，请使用密码登录。");
      const password = req.body.password;
      if (
        typeof password !== "string" ||
        password.length < 8 ||
        password.length > 256
      )
        return fail(res, 400, "请设置 8–256 位访问密码。");
      settingUp = true;
      try {
        const salt = randomBytes(16).toString("hex");
        const hash = (await hashPassword(password, salt, 64)).toString("hex");
        db.prepare("INSERT INTO settings VALUES (?, ?)").run(
          "password",
          `${salt}:${hash}`,
        );
        issueSession(req, res);
        res.json({ ok: true });
      } finally {
        settingUp = false;
      }
    }),
  );
  app.post(
    "/api/login",
    authLimit,
    asyncRoute(async (req, res) => {
      const saved = getSetting("password");
      if (!saved) return fail(res, 409, "请先在本机完成首次设置。");
      if (
        typeof req.body.password !== "string" ||
        req.body.password.length > 256
      )
        return fail(res, 400, "请输入访问密码。");
      const [salt, expected] = saved.split(":");
      const actual = await hashPassword(req.body.password, salt, 64);
      if (saved !== getSetting("password") || !timingSafeEqual(actual, Buffer.from(expected, "hex")))
        return fail(res, 401, "密码不正确，请重新输入。");
      issueSession(req, res);
      res.json({ ok: true });
    }),
  );
  app.post("/api/logout", auth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
      req.session.token_hash,
    );
    for (const [response, client] of streams)
      if (client.session === req.session.token_hash) {
        response.end();
        streams.delete(response);
      }
    res.clearCookie("assistant_session", { path: "/" });
    res.json({ ok: true });
  });
  app.post("/api/password", auth, authLimit, asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== "string" || currentPassword.length > 256 ||
        typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 256)
      return fail(res, 400, "请输入当前密码，新密码需要 8–256 位。");
    if (currentPassword === newPassword) return fail(res, 400, "新密码不能与当前密码相同。");
    const saved = getSetting("password");
    const [salt, expected] = saved.split(":");
    const actual = await hashPassword(currentPassword, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(expected, "hex")))
      return fail(res, 403, "当前密码不正确，请重新输入。");
    const nextSalt = randomBytes(16).toString("hex");
    const nextHash = (await hashPassword(newPassword, nextSalt, 64)).toString("hex");
    if (saved !== getSetting("password") || !session(req))
      return fail(res, 409, "密码已在其他页面修改，请重新登录后再试。");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE settings SET value=? WHERE key='password'").run(`${nextSalt}:${nextHash}`);
      db.prepare("DELETE FROM sessions").run();
      issueSession(req, res);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const [response, client] of streams) {
      if (client.session !== req.session.token_hash)
        response.write(`data: ${JSON.stringify({ type: "session-revoked" })}\n\n`);
      response.end();
    }
    streams.clear();
    res.json({ ok: true });
  }));
  const presence = () => [
    ...new Map(
      [...streams.values()].map((c) => [
        c.deviceId,
        { id: c.deviceId, name: c.name },
      ]),
    ).values(),
  ];
  const broadcast = (event) => {
    for (const response of streams.keys())
      response.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  app.get("/api/events", auth, (req, res) => {
    const { deviceId } = req.query;
    if (!validId(deviceId)) return fail(res, 400, "设备信息无效，请刷新页面。");
    const device = db
      .prepare("SELECT * FROM devices WHERE id = ?")
      .get(deviceId);
    if (!device) return fail(res, 400, "请先登记当前设备。");
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    streams.set(res, {
      deviceId,
      name: device.name,
      session: req.session.token_hash,
    });
    broadcast({ type: "presence", devices: presence() });
    const timer = setInterval(() => {
      if (
        !db
          .prepare(
            "SELECT 1 FROM sessions WHERE token_hash = ? AND expires > ?",
          )
          .get(req.session.token_hash, Date.now())
      )
        return res.end();
      res.write(": heartbeat\n\n");
    }, 25000);
    req.on("close", () => {
      clearInterval(timer);
      streams.delete(res);
      broadcast({ type: "presence", devices: presence() });
    });
  });
  app.post("/api/devices", auth, (req, res) => {
    const { id, name } = req.body;
    if (
      !validId(id) ||
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 30
    )
      return fail(res, 400, "设备名称需要 1–30 个字。");
    db.prepare(
      "INSERT INTO devices VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, last_seen=excluded.last_seen",
    ).run(id, name.trim(), Date.now());
    for (const client of streams.values())
      if (client.deviceId === id) client.name = name.trim();
    broadcast({ type: "presence", devices: presence() });
    res.json({ id, name: name.trim() });
  });
  app.get("/api/stats", auth, (req, res) => {
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(kind='text') AS text, SUM(kind='image') AS image, SUM(kind='file') AS file FROM messages WHERE deleted_at IS NULL`,
      )
      .get();
    res.json({
      ...counts,
      trash: db
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NOT NULL",
        )
        .get().n,
      usedBytes: usedBytes(),
      maxStorageBytes,
      maxFileBytes,
      trashRetentionDays: retentionDays(),
      pendingDeletionFiles: pendingFiles(),
    });
  });
  app.get("/api/settings", auth, (req, res) => res.json({
    trashRetentionDays: retentionDays(),
    cleanupIntervalHours: 1,
    lastCleanupAt: Number(getSetting("last_cleanup_at")) || null,
    pendingDeletionFiles: pendingFiles(),
  }));
  app.put("/api/settings", auth, (req, res) => {
    const days = req.body.trashRetentionDays;
    if (!Number.isInteger(days) || ![0, 1, 7, 30, 90].includes(days))
      return fail(res, 400, "请选择关闭，或保留 1、7、30、90 天。");
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('trash_retention_days', ?)").run(String(days));
    broadcast({ type: "change" });
    res.json({ trashRetentionDays: days });
  });
  app.get("/api/trash/preview", auth, (req, res) => res.json(trashSnapshot()));
  app.post("/api/trash/empty", auth, asyncRoute(async (req, res) => {
    const snapshot = trashSnapshot();
    if (req.body.confirm !== true || typeof req.body.token !== "string")
      return fail(res, 400, "请先确认要永久清空的内容。");
    if (req.body.token !== snapshot.token)
      return fail(res, 409, "最近删除的内容已变化，请重新确认后再清空。");
    const deletedCount = enqueuePurge(Number.MAX_SAFE_INTEGER);
    await flushDeletedFiles();
    broadcast({ type: "change" });
    res.json({ deletedCount, pendingFiles: pendingFiles() });
  }));
  function messageFilter(query) {
    const conditions = [
      query.trash === "1" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL",
    ];
    const params = [];
    if (["text", "image", "file"].includes(query.kind)) {
      conditions.push("kind = ?");
      params.push(query.kind);
    }
    if (query.q) {
      conditions.push(
        "(text LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\')",
      );
      const q = `%${String(query.q)
        .slice(0, 200)
        .replace(/[\\%_]/g, "\\$&")}%`;
      params.push(q, q);
    }
    // Browser-local calendar dates arrive as an inclusive start and exclusive end.
    const bounds = {};
    for (const key of ["from", "until"]) {
      if (query[key] === undefined) continue;
      if (typeof query[key] !== "string" || !/^-?\d+$/.test(query[key]) ||
          !Number.isSafeInteger(Number(query[key])) || Math.abs(Number(query[key])) > 864e13) {
        const error = new Error("日期范围无效，请重新选择。");
        error.code = "INVALID_DATE_RANGE";
        throw error;
      }
      bounds[key] = Number(query[key]);
      conditions.push(`created_at ${key === "from" ? ">=" : "<"} ?`);
      params.push(bounds[key]);
    }
    if (bounds.from !== undefined && bounds.until !== undefined && bounds.from >= bounds.until) {
      const error = new Error("开始日期不能晚于结束日期。");
      error.code = "INVALID_DATE_RANGE";
      throw error;
    }
    return { conditions, params };
  }
  app.get("/api/messages/selection", auth, (req, res) => {
    const { conditions, params } = messageFilter(req.query);
    // Preview matching IDs and total attachment size without loading message bodies.
    const rows = db.prepare(`SELECT id, size FROM messages WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT 10001`).all(...params);
    if (rows.length > 10000)
      return fail(res, 400, "一次最多处理 10000 条，请按日期、分类或搜索缩小范围。");
    res.json({ ids: rows.map((row) => row.id), bytes: rows.reduce((total, row) => total + row.size, 0) });
  });
  app.patch("/api/messages/batch", auth, (req, res) => {
    const { ids, deleted } = req.body;
    if (typeof deleted !== "boolean" || !Array.isArray(ids) || !ids.length || ids.length > 10000 ||
        ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      return fail(res, 400, "请重新查看匹配记录后重试，一次最多处理 10000 条。");
    const selected = [...new Set(ids)];
    const encoded = JSON.stringify(selected);
    const condition = `id IN (SELECT value FROM json_each(?)) AND deleted_at IS ${deleted ? "NULL" : "NOT NULL"}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const available = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${condition}`).get(encoded).n;
      if (available !== selected.length) {
        db.exec("ROLLBACK");
        return fail(res, 409, "部分记录已被删除或恢复，本次未作更改。请重新查看匹配记录后再确认。");
      }
      const result = db.prepare(`UPDATE messages SET deleted_at=? WHERE ${condition}`).run(deleted ? Date.now() : null, encoded);
      db.exec("COMMIT");
      broadcast({ type: "change" });
      res.json({ changedCount: Number(result.changes) });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  app.get("/api/messages", auth, (req, res) => {
    const { conditions, params } = messageFilter(req.query);
    const before = Number(req.query.before);
    if (Number.isSafeInteger(before) && before > 0) {
      conditions.push("id < ?");
      params.push(before);
    }
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT 61`,
      )
      .all(...params);
    res.json({
      messages: rows.slice(0, 60).reverse().map(publicMessage),
      hasMore: rows.length > 60,
    });
  });
  function getDevice(req, res) {
    const id = req.get("X-Device-Id");
    if (!validId(id)) {
      fail(res, 400, "设备信息无效，请刷新页面。");
      return null;
    }
    const device = db.prepare("SELECT * FROM devices WHERE id=?").get(id);
    if (!device) fail(res, 400, "设备未登记，请刷新页面。");
    return device;
  }
  const insert = db.prepare(
    "INSERT INTO messages (request_id, device_id, device_name, kind, text, file_name, file_key, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  app.post("/api/messages", auth, (req, res) => {
    const device = getDevice(req, res);
    if (!device) return;
    const { text, requestId } = req.body;
    if (
      !validId(requestId) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 100000
    )
      return fail(res, 400, "请输入内容，最多支持 10 万字。");
    let row = db
      .prepare("SELECT * FROM messages WHERE request_id=?")
      .get(requestId);
    if (!row) {
      const result = insert.run(
        requestId,
        device.id,
        device.name,
        "text",
        text,
        null,
        null,
        null,
        0,
        Date.now(),
      );
      row = db
        .prepare("SELECT * FROM messages WHERE id=?")
        .get(result.lastInsertRowid);
      broadcast({ type: "change" });
    }
    res.json(publicMessage(row));
  });
  const upload = multer({
    dest: tmpDir,
    limits: { fileSize: maxFileBytes, files: 1, fields: 0, parts: 2 },
  });
  app.post(
    "/api/files",
    auth,
    (req, res, next) => {
      req.device = getDevice(req, res);
      if (!req.device) return;
      const id = req.get("X-Request-Id");
      if (!validId(id)) return fail(res, 400, "上传编号无效。");
      const existing = db
        .prepare("SELECT * FROM messages WHERE request_id = ?")
        .get(id);
      if (existing) return res.json(publicMessage(existing));
      if (reserved.has(id))
        return fail(res, 409, "该文件正在上传，请稍后再试。");
      if (reserved.size >= 4)
        return fail(res, 429, "同时上传的文件过多，请稍后重试。");
      const bytes = Number(req.get("Content-Length"));
      if (bytes > maxFileBytes + 65536)
        return fail(
          res,
          413,
          `单个文件不能超过 ${Math.floor(maxFileBytes / 1024 ** 2)} MB。`,
        );
      if (usedBytes() >= maxStorageBytes)
        return fail(res, 413, "存储空间已满。");
      reserved.add(id);
      res.on("close", () => reserved.delete(id));
      upload.single("file")(req, res, (error) => {
        if (error) return next(error);
        if (req.aborted) {
          if (req.file)
            try {
              unlinkSync(req.file.path);
            } catch {}
          return;
        }
        next();
      });
    },
    (req, res, next) => {
      if (!req.file) return fail(res, 400, "请选择要上传的文件。");
      const temp = req.file.path;
      let target;
      try {
        if (usedBytes() + req.file.size > maxStorageBytes) {
          unlinkSync(temp);
          return fail(res, 413, "剩余存储空间不足，文件未保存。");
        }
        let originalName = req.file.originalname;
        const decoded = Buffer.from(originalName, "latin1").toString("utf8");
        if (!decoded.includes("\ufffd")) originalName = decoded;
        const name =
          path
            .basename(originalName.replaceAll("\\", "/"))
            .replace(/[\x00-\x1f\x7f]/g, "")
            .slice(0, 240) || "未命名文件";
        const fd = openSync(temp, "r");
        const header = Buffer.alloc(16);
        readSync(fd, header, 0, 16, 0);
        closeSync(fd);
        const mime = header
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : header[0] === 255 && header[1] === 216 && header[2] === 255
            ? "image/jpeg"
            : ["GIF87a", "GIF89a"].includes(header.toString("ascii", 0, 6))
              ? "image/gif"
              : header.toString("ascii", 0, 4) === "RIFF" &&
                  header.toString("ascii", 8, 12) === "WEBP"
                ? "image/webp"
                : "application/octet-stream";
        const key = randomUUID();
        target = path.join(filesDir, key);
        renameSync(temp, target);
        const result = insert.run(
          req.get("X-Request-Id"),
          req.device.id,
          req.device.name,
          mime.startsWith("image/") ? "image" : "file",
          "",
          name,
          key,
          mime,
          req.file.size,
          Date.now(),
        );
        const row = db
          .prepare("SELECT * FROM messages WHERE id=?")
          .get(result.lastInsertRowid);
        broadcast({ type: "change" });
        res.json(publicMessage(row));
      } catch (error) {
        for (const file of [temp, target])
          if (file && existsSync(file)) unlinkSync(file);
        next(error);
      }
    },
  );
  app.get("/api/files/:id", auth, (req, res) => {
    const row = db
      .prepare("SELECT * FROM messages WHERE id=? AND deleted_at IS NULL")
      .get(req.params.id);
    if (!row?.file_key || !existsSync(path.join(filesDir, row.file_key)))
      return fail(res, 404, "文件不存在或已移到最近删除。");
    const inline = req.query.preview === "1" && row.kind === "image";
    res.type(inline ? row.mime : "application/octet-stream");
    res.set(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="download"; filename*=UTF-8''${encodeURIComponent(row.file_name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
    );
    res.sendFile(path.join(filesDir, row.file_key));
  });
  app.patch("/api/messages/:id", auth, (req, res) => {
    const row = db
      .prepare("SELECT * FROM messages WHERE id=?")
      .get(req.params.id);
    if (!row) return fail(res, 404, "这条记录不存在。");
    if (typeof req.body.deleted !== "boolean")
      return fail(res, 400, "操作无效。");
    db.prepare("UPDATE messages SET deleted_at=? WHERE id=?").run(
      req.body.deleted ? Date.now() : null,
      row.id,
    );
    broadcast({ type: "change" });
    res.json({ ok: true });
  });
  app.use("/api", (req, res) => fail(res, 404, "接口不存在。"));
  app.get("/vendor/lucide.js", (req, res) =>
    res.sendFile(path.join(root, "../node_modules/lucide/dist/umd/lucide.js")),
  );
  app.use(express.static(path.join(root, "public"), { etag: true, maxAge: 0 }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === "LIMIT_FILE_SIZE")
      return fail(
        res,
        413,
        `单个文件不能超过 ${Math.floor(maxFileBytes / 1024 ** 2)} MB。`,
      );
    if (error instanceof multer.MulterError)
      return fail(res, 400, "文件上传失败，请一次上传一个文件。");
    if (error.status === 413)
      return fail(res, 413, "内容太大，请缩短文字后重试。");
    if (error instanceof SyntaxError && error.status === 400)
      return fail(res, 400, "请求格式错误。");
    if (error.code === "INVALID_DATE_RANGE")
      return fail(res, 400, error.message);
    console.error("Assistant request failed:", error.code || error.name);
    fail(res, 500, "保存失败，请稍后重试。原内容仍保留在输入区。");
  });
  const cleanupTimer = setInterval(() => {
    runCleanup().catch((error) => console.error("Scheduled cleanup failed:", error.code || error.name));
  }, cleanupIntervalMs);
  cleanupTimer.unref();
  // Catch up after downtime; keep the user's chosen seven-day default.
  const startupCleanup = setTimeout(() => {
    runCleanup().catch((error) => console.error("Startup cleanup failed:", error.code || error.name));
  }, 1000);
  startupCleanup.unref();
  return {
    app,
    db,
    runCleanup,
    disconnect() {
      for (const response of streams.keys()) response.end();
      streams.clear();
    },
    close() {
      closed = true;
      clearInterval(cleanupTimer);
      clearTimeout(startupCleanup);
      this.disconnect();
      db.close();
    },
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const assistant = createAssistant();
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 4826);
  const server = assistant.app.listen(port, host, () =>
    console.log(
      `文件传输助手已启动：http://${host}:${port}\n数据保存在 ${path.resolve(process.env.DATA_DIR || path.join(root, "../data"))}`,
    ),
  );
  server.requestTimeout = 10 * 60e3;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      // Let active uploads commit before closing SQLite during container stop.
      assistant.disconnect();
      server.close(() => {
        assistant.close();
        process.exit(0);
      });
      setTimeout(() => server.closeAllConnections(), 25_000).unref();
    });
}
