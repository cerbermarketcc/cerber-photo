import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const dbPath = path.join(uploadDir, "photos.json");
const legacyKeysPath = path.join(uploadDir, ".legacy-photo-keys.json");
const sessionSecretPath = path.join(uploadDir, ".photo-session-secret");
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
const maxUploadBytes = positiveNumber(process.env.MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
const maxFilesPerUpload = positiveNumber(process.env.MAX_FILES_PER_UPLOAD, 20);
const maxFileBytes = positiveNumber(process.env.MAX_FILE_BYTES, 10 * 1024 * 1024);
const uploadRateLimit = positiveNumber(process.env.UPLOAD_RATE_LIMIT, 10);
const uploadRateWindowMs = positiveNumber(process.env.UPLOAD_RATE_WINDOW_MS, 10 * 60 * 1000);
const accessRateLimit = positiveNumber(process.env.ACCESS_RATE_LIMIT, 30);
const accessRateWindowMs = positiveNumber(process.env.ACCESS_RATE_WINDOW_MS, 60 * 1000);
const photoSessionTtlSeconds = positiveNumber(process.env.PHOTO_SESSION_TTL_SECONDS, 60 * 60);
const maxStorageBytes = positiveNumber(process.env.MAX_STORAGE_BYTES, 2 * 1024 * 1024 * 1024);
const r2Bucket = String(process.env.R2_BUCKET || "").trim();
const r2Endpoint = String(process.env.R2_ENDPOINT || "").trim().replace(/\/$/, "");
const r2AccessKeyId = String(process.env.R2_ACCESS_KEY_ID || "").trim();
const r2SecretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || "").trim();
const r2Prefix = String(process.env.R2_PREFIX || "cerber-photo").trim().replace(/^\/+|\/+$/g, "");
const r2RetryMs = positiveNumber(process.env.R2_RETRY_MS, 60 * 1000);
const primaryStorageCheckTtlMs = 30 * 1000;
const appBuild = String(process.env.RENDER_GIT_COMMIT || process.env.APP_BUILD || "local").trim().slice(0, 40) || "local";
const rateBuckets = new Map();
let dbWriteQueue = Promise.resolve();
const pendingBackups = new Map();
let backupWorker = null;
let backupRetryTimer = null;
let backupLastErrorAt = null;
let backupLastSuccessAt = null;
let backupInitialCheckComplete = false;
let primaryStorageCheck = null;
let primaryStorageCheckResult = null;
let primaryStorageCheckExpiresAt = 0;

const r2Settings = [r2Bucket, r2Endpoint, r2AccessKeyId, r2SecretAccessKey];
if (r2Settings.some(Boolean) && !r2Settings.every(Boolean)) {
  throw new Error("R2 backup is incomplete. Set R2_BUCKET, R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY");
}

const r2 = r2Settings.every(Boolean) ? new S3Client({
  region: "auto",
  endpoint: r2Endpoint,
  forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: r2AccessKeyId,
    secretAccessKey: r2SecretAccessKey
  }
}) : null;

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif"
};

const extensionByMime = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif"
};

await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
const sessionSecret = await loadOrCreateSessionSecret();
await migrateLegacyPhotos();

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadOrCreateSessionSecret() {
  const configured = String(process.env.PHOTO_SESSION_SECRET || "").trim();
  if (configured) {
    if (configured.length < 32) throw new Error("PHOTO_SESSION_SECRET must contain at least 32 characters");
    return configured;
  }

  try {
    const stored = (await fs.readFile(sessionSecretPath, "utf8")).trim();
    if (stored.length >= 32) return stored;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const generated = crypto.randomBytes(48).toString("base64url");
  await fs.writeFile(sessionSecretPath, generated, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return generated;
}

function securityHeaders(extra = {}) {
  return {
    "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow, noarchive, noimageindex",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ...(isProduction ? { "strict-transport-security": "max-age=31536000" } : {}),
    ...extra
  };
}

function send(res, status, body = "", headers = {}, method = "GET") {
  res.writeHead(status, securityHeaders(headers));
  res.end(method === "HEAD" ? undefined : body);
}

function sendJson(res, status, body, method = "GET") {
  send(res, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  }, method);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

async function readDb() {
  try {
    const raw = await fs.readFile(dbPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Invalid photo database");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function checkPrimaryStorage() {
  if (primaryStorageCheckResult && Date.now() < primaryStorageCheckExpiresAt) {
    return primaryStorageCheckResult;
  }
  if (primaryStorageCheck) return primaryStorageCheck;

  const check = (async () => {
    const probePath = path.join(uploadDir, `.health-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    const checkedAt = new Date().toISOString();
    try {
      await fs.writeFile(probePath, "ok", { encoding: "utf8", mode: 0o600, flag: "wx" });
      const probe = await fs.readFile(probePath, "utf8");
      if (probe !== "ok") throw new Error("Primary storage probe mismatch");
      await fs.unlink(probePath);
      await readDb();
      return { status: "ready", checkedAt };
    } catch (error) {
      await fs.unlink(probePath).catch(() => {});
      console.error(`[health] primary storage check failed (${error?.code || error?.name || "unknown"})`);
      return { status: "unavailable", checkedAt };
    }
  })();

  primaryStorageCheck = check;
  try {
    const result = await check;
    primaryStorageCheckResult = result;
    primaryStorageCheckExpiresAt = Date.now() + primaryStorageCheckTtlMs;
    return result;
  } finally {
    if (primaryStorageCheck === check) primaryStorageCheck = null;
  }
}

async function writePrivateJson(filePath, value) {
  const tmpPath = `${filePath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

async function writeDb(db) {
  await writePrivateJson(dbPath, db);
}

async function updateDb(mutator) {
  const nextWrite = dbWriteQueue.catch(() => {}).then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  dbWriteQueue = nextWrite;
  return nextWrite;
}

function r2Key(type, name) {
  return [r2Prefix, type, name].filter(Boolean).join("/");
}

function validPhotoRecord(id, photo) {
  return Boolean(
    photo &&
    typeof photo === "object" &&
    photo.id === id &&
    /^[a-f0-9]{24,32}$/.test(id) &&
    new RegExp(`^${id}\\.(?:jpg|png|gif|webp|avif)$`).test(String(photo.storedName || "")) &&
    Object.hasOwn(extensionByMime, String(photo.contentType || "")) &&
    Number.isFinite(Number(photo.size)) &&
    Number(photo.size) > 0 &&
    /^[A-Za-z0-9_-]{43}$/.test(String(photo.accessHash || ""))
  );
}

async function bodyToBuffer(body) {
  if (!body) throw new Error("R2 returned an empty object");
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function deleteBackupRecord(record) {
  if (!r2) return;
  await Promise.allSettled([
    r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: r2Key("photos", record.storedName) })),
    r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: r2Key("records", `${record.id}.json`) }))
  ]);
}

async function backupPhoto(record, content) {
  if (!r2) return;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: r2Bucket,
      Key: r2Key("photos", record.storedName),
      Body: content,
      ContentType: record.contentType,
      CacheControl: "private, no-store"
    }));
    await r2.send(new PutObjectCommand({
      Bucket: r2Bucket,
      Key: r2Key("records", `${record.id}.json`),
      Body: JSON.stringify(record),
      ContentType: "application/json",
      CacheControl: "no-store"
    }));
  } catch (error) {
    await deleteBackupRecord(record);
    throw error;
  }
}

function currentBackupStatus() {
  if (!r2) {
    return { configured: false, status: "disabled", pending: 0 };
  }

  const pending = pendingBackups.size;
  return {
    configured: true,
    status: !backupInitialCheckComplete
      ? (backupLastErrorAt ? "degraded" : "checking")
      : pending
        ? (backupLastErrorAt ? "degraded" : "syncing")
        : "ready",
    pending,
    ...(backupLastSuccessAt ? { lastSuccessAt: backupLastSuccessAt } : {}),
    ...(backupLastErrorAt ? { lastErrorAt: backupLastErrorAt } : {})
  };
}

function scheduleBackupRetry() {
  if (!r2 || !pendingBackups.size || backupRetryTimer) return;
  backupRetryTimer = setTimeout(() => {
    backupRetryTimer = null;
    void drainBackupQueue();
  }, r2RetryMs);
  backupRetryTimer.unref?.();
}

function enqueuePhotoBackups(records) {
  if (!r2) return;
  for (const record of records) pendingBackups.set(record.id, record);
  void drainBackupQueue();
}

async function drainBackupQueue() {
  if (!r2) return;
  if (backupWorker) return backupWorker;

  const worker = (async () => {
    for (const [id, record] of pendingBackups) {
      try {
        const content = await fs.readFile(path.join(uploadDir, record.storedName));
        await backupPhoto(record, content);
        pendingBackups.delete(id);
        backupLastSuccessAt = new Date().toISOString();
        console.log(`[backup] copied photo ${id} to R2`);
      } catch (error) {
        backupLastErrorAt = new Date().toISOString();
        console.error(`[backup] photo ${id} remains queued`, error);
      }
    }
  })();

  backupWorker = worker;
  try {
    await worker;
  } finally {
    if (backupWorker === worker) backupWorker = null;
    if (pendingBackups.size) scheduleBackupRetry();
  }
}

async function readBackupRecord(id) {
  if (!r2) return null;
  try {
    const object = await r2.send(new GetObjectCommand({
      Bucket: r2Bucket,
      Key: r2Key("records", `${id}.json`)
    }));
    const record = JSON.parse((await bodyToBuffer(object.Body)).toString("utf8"));
    return validPhotoRecord(id, record) ? record : null;
  } catch (error) {
    if (["NoSuchKey", "NotFound"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function getPhotoRecord(id) {
  const db = await readDb();
  if (validPhotoRecord(id, db[id])) return db[id];

  const restored = await readBackupRecord(id);
  if (!restored) return null;
  await updateDb((current) => {
    current[id] = restored;
  });
  console.log(`[backup] restored photo record ${id} from R2`);
  return restored;
}

async function readPhotoContent(photo) {
  const localPath = path.join(uploadDir, photo.storedName);
  try {
    return await fs.readFile(localPath);
  } catch (error) {
    if (error.code !== "ENOENT" || !r2) throw error;
  }

  const object = await r2.send(new GetObjectCommand({
    Bucket: r2Bucket,
    Key: r2Key("photos", photo.storedName)
  }));
  const content = await bodyToBuffer(object.Body);
  if (content.length !== Number(photo.size) || detectImageType(content) !== photo.contentType) {
    throw new Error("Invalid photo backup");
  }
  await fs.writeFile(localPath, content, { mode: 0o600, flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  console.log(`[backup] restored photo file ${photo.id} from R2`);
  return content;
}

async function backupObjectExists(key) {
  try {
    await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
    return true;
  } catch (error) {
    if (["NoSuchKey", "NotFound"].includes(error?.name) || error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function backupExistingPhotos() {
  if (!r2) return;
  const entries = Object.entries(await readDb()).filter(([id, photo]) => validPhotoRecord(id, photo));
  const missing = [];

  for (let index = 0; index < entries.length; index += 3) {
    const group = entries.slice(index, index + 3);
    await Promise.all(group.map(async ([, photo]) => {
      try {
        const photoKey = r2Key("photos", photo.storedName);
        const recordKey = r2Key("records", `${photo.id}.json`);
        const [hasPhoto, hasRecord] = await Promise.all([
          backupObjectExists(photoKey),
          backupObjectExists(recordKey)
        ]);
        if (!hasPhoto || !hasRecord) missing.push(photo);
      } catch (error) {
        backupLastErrorAt = new Date().toISOString();
        console.error(`[backup] could not inspect photo ${photo.id}; queued for retry`, error);
        missing.push(photo);
      }
    }));
  }

  console.log(`[backup] R2 scan finished; ${entries.length} photo(s) checked, ${missing.length} queued`);
  enqueuePhotoBackups(missing);
}

function createAccessToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashAccessToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("base64url");
}

function secretValuesMatch(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

async function migrateLegacyPhotos() {
  const db = await readDb();
  const legacyKeys = {};
  let migrated = 0;

  for (const [id, photo] of Object.entries(db)) {
    if (!photo || typeof photo !== "object" || photo.accessHash) continue;
    const accessToken = createAccessToken();
    photo.accessHash = hashAccessToken(accessToken);
    legacyKeys[id] = accessToken;
    migrated += 1;
  }

  if (!migrated) return;

  let existingRecovery = {};
  try {
    existingRecovery = JSON.parse(await fs.readFile(legacyKeysPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await writePrivateJson(dbPath, db);
  await writePrivateJson(legacyKeysPath, { ...existingRecovery, ...legacyKeys });
  console.warn(`[privacy] revoked ${migrated} legacy public photo link(s); recovery keys stored outside the public directory`);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxUploadBytes) {
        settled = true;
        const error = new Error("Загрузка слишком большая.");
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function collectJson(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        const error = new Error("Invalid request");
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        const error = new Error("Invalid JSON");
        error.status = 400;
        reject(error);
      }
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function parseContentDisposition(value = "") {
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawVal] = part.trim().split("=");
    if (!rawVal.length) continue;
    result[rawKey.toLowerCase()] = rawVal.join("=").replace(/^"|"$/g, "");
  }
  return result;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))(?:;|$)/i);
  if (!boundaryMatch) throw new Error("Не найден multipart boundary.");

  const boundary = Buffer.from(`--${boundaryMatch[1] || boundaryMatch[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);

  while (cursor !== -1) {
    const next = buffer.indexOf(boundary, cursor + boundary.length);
    if (next === -1) break;

    let part = buffer.subarray(cursor + boundary.length, next);
    cursor = next;

    if (part.subarray(0, 2).toString() === "--") break;
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1 || headerEnd > 8192) continue;

    const rawHeaders = part.subarray(0, headerEnd).toString("utf8");
    const headers = {};
    for (const line of rawHeaders.split("\r\n")) {
      const splitAt = line.indexOf(":");
      if (splitAt <= 0) continue;
      headers[line.slice(0, splitAt).toLowerCase()] = line.slice(splitAt + 1).trim();
    }

    const disposition = parseContentDisposition(headers["content-disposition"]);
    const content = part.subarray(headerEnd + 4);
    if (disposition.filename && content.length) {
      parts.push({
        contentType: String(headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase(),
        content
      });
    }
  }

  return parts;
}

function detectImageType(content) {
  if (content.length > 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.length > 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const gifSignature = content.subarray(0, 6).toString("ascii");
  if (gifSignature === "GIF87a" || gifSignature === "GIF89a") return "image/gif";
  if (content.length > 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (content.length > 12 && content.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(content.subarray(8, 12).toString("ascii"))) return "image/avif";
  return "";
}

function clientIp(req) {
  const cloudflareIp = String(req.headers["cf-connecting-ip"] || "").trim();
  const forwardedIp = String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim();
  return cloudflareIp || forwardedIp || req.socket.remoteAddress || "unknown";
}

function consumeRateLimit(scope, req, limit, windowMs, suffix = "") {
  const now = Date.now();
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  const key = `${scope}:${clientIp(req)}:${suffix}`;
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  current.count += 1;
  if (current.count <= limit) return { allowed: true, retryAfter: 0 };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
}

function rejectCrossSite(req, res) {
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") {
    sendJson(res, 403, { error: "Запрос отклонён." });
    return true;
  }

  const origin = String(req.headers.origin || "");
  if (!origin) return false;

  try {
    if (new URL(origin).host === String(req.headers.host || "")) return false;
  } catch {}

  sendJson(res, 403, { error: "Запрос отклонён." });
  return true;
}

function parseCookies(req) {
  const cookies = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const splitAt = item.indexOf("=");
    if (splitAt <= 0) continue;
    cookies[item.slice(0, splitAt).trim()] = item.slice(splitAt + 1).trim();
  }
  return cookies;
}

function signPhotoSession(id) {
  const payload = Buffer.from(JSON.stringify({
    id,
    exp: Date.now() + photoSessionTtlSeconds * 1000,
    nonce: crypto.randomBytes(12).toString("base64url")
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyPhotoSession(value, expectedId) {
  const [payload, signature, extra] = String(value || "").split(".");
  if (!payload || !signature || extra) return false;
  const expectedSignature = crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  if (!secretValuesMatch(signature, expectedSignature)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.id === expectedId && Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

async function servePublic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : safeDecode(url.pathname);
  const filePath = path.resolve(publicDir, `.${requested}`);
  const relative = path.relative(publicDir, filePath);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;

  try {
    const content = await fs.readFile(filePath);
    send(res, 200, content, {
      "content-type": mimeByExt[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-cache"
    }, req.method);
    return true;
  } catch {
    return false;
  }
}

async function handleUpload(req, res) {
  const rate = consumeRateLimit("upload", req, uploadRateLimit, uploadRateWindowMs);
  if (!rate.allowed) {
    sendJson(res, 429, { error: "Слишком много загрузок. Попробуйте позже." });
    return;
  }

  const storedPaths = [];
  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      sendJson(res, 400, { error: "Нужно отправить фото через форму." });
      return;
    }
    if (Number(req.headers["content-length"] || 0) > maxUploadBytes) {
      sendJson(res, 413, { error: "Загрузка слишком большая." });
      return;
    }

    const body = await collectBody(req);
    const files = parseMultipart(body, contentType);
    if (!files.length) {
      sendJson(res, 400, { error: "Фото не выбраны." });
      return;
    }

    if (files.length > maxFilesPerUpload) {
      sendJson(res, 400, { error: `За один раз можно загрузить максимум ${maxFilesPerUpload} фото.` });
      return;
    }

    const created = [];
    const records = [];

    for (const [uploadIndex, file] of files.entries()) {
      if (file.content.length > maxFileBytes) continue;
      const detectedType = detectImageType(file.content);
      if (!detectedType || detectedType !== file.contentType) continue;

      const id = crypto.randomBytes(16).toString("hex");
      const accessToken = createAccessToken();
      const storedName = `${id}${extensionByMime[detectedType]}`;
      const storedPath = path.join(uploadDir, storedName);
      await fs.writeFile(storedPath, file.content, { mode: 0o600, flag: "wx" });
      storedPaths.push(storedPath);

      records.push({
        id,
        storedName,
        contentType: detectedType,
        size: file.content.length,
        accessHash: hashAccessToken(accessToken),
        createdAt: new Date().toISOString()
      });

      created.push({
        id,
        uploadIndex,
        url: `/p/${id}#key=${accessToken}`
      });
    }

    if (!created.length) {
      sendJson(res, 400, { error: "Поддерживаются только настоящие JPG, PNG, GIF, WEBP или AVIF фото до 10 MB." });
      return;
    }

    await updateDb((db) => {
      const usedBytes = Object.values(db).reduce((total, photo) => total + Math.max(0, Number(photo?.size || 0)), 0);
      const incomingBytes = records.reduce((total, photo) => total + photo.size, 0);
      if (usedBytes + incomingBytes > maxStorageBytes) {
        const error = new Error("Хранилище заполнено.");
        error.status = 507;
        throw error;
      }
      for (const record of records) db[record.id] = record;
    });

    enqueuePhotoBackups(records);
    sendJson(res, 201, { photos: created });
  } catch (error) {
    await Promise.allSettled(storedPaths.map((storedPath) => fs.unlink(storedPath)));
    console.error("[upload]", error);
    const publicError = [413, 507].includes(error.status) ? error.message : "Не удалось загрузить фото.";
    sendJson(res, error.status || 400, { error: publicError });
  }
}

async function handlePhotoSession(req, res, id) {
  const rate = consumeRateLimit("photo-access", req, accessRateLimit, accessRateWindowMs, id);
  if (!rate.allowed) {
    sendJson(res, 429, { error: "Слишком много попыток. Попробуйте позже." });
    return;
  }

  try {
    const body = await collectJson(req);
    const key = typeof body.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.key) ? body.key : "";
    const photo = await getPhotoRecord(id);
    if (!photo?.accessHash || !secretValuesMatch(hashAccessToken(key), photo.accessHash)) {
      sendJson(res, 404, { error: "Фото недоступно." });
      return;
    }

    const cookie = [
      `cerber_photo_access_${id}=${signPhotoSession(id)}`,
      "HttpOnly",
      "SameSite=Strict",
      `Path=/image/${id}`,
      `Max-Age=${photoSessionTtlSeconds}`,
      ...(isProduction ? ["Secure"] : [])
    ].join("; ");

    send(res, 204, "", {
      "set-cookie": cookie,
      "cache-control": "no-store"
    }, req.method);
  } catch (error) {
    if (error.status) return sendJson(res, error.status, { error: "Неверный запрос." });
    console.error("[photo-session] storage failure", { name: error.name, code: error.code });
    sendJson(res, 503, { error: "Хранилище временно недоступно. Попробуйте позже." });
  }
}

async function handleImage(req, res, id) {
  const cookies = parseCookies(req);
  const session = cookies[`cerber_photo_access_${id}`];
  if (!verifyPhotoSession(session, id) && !verifyPhotoSession(cookies.cerber_photo_access, id)) {
    send(res, 404, "Фото недоступно", { "cache-control": "no-store" }, req.method);
    return;
  }

  try {
    const photo = await getPhotoRecord(id);
    if (!photo || !/^[a-f0-9]{24,32}\.(?:jpg|png|gif|webp|avif)$/.test(String(photo.storedName || ""))) {
      send(res, 404, "Фото недоступно", { "cache-control": "no-store" }, req.method);
      return;
    }

    const content = await readPhotoContent(photo);
    send(res, 200, content, {
      "content-type": photo.contentType,
      "content-disposition": "inline",
      "cache-control": "private, no-store, max-age=0",
      pragma: "no-cache"
    }, req.method);
  } catch (error) {
    const missing = error.code === "ENOENT" || ["NoSuchKey", "NotFound"].includes(error.name) || error?.$metadata?.httpStatusCode === 404;
    send(res, missing ? 404 : 503, missing ? "Фото недоступно" : "Хранилище временно недоступно", { "cache-control": "no-store" }, req.method);
  }
}

function handlePhotoPage(req, res, id) {
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#070708">
  <title>CERBER PHOTO</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="viewer" data-photo-id="${id}">
  <header class="viewer-bar">
    <a class="brand" href="/" aria-label="CERBER PHOTO">
      <img src="/assets/cerber-header-logo.png" alt="">
      <span>
        <strong>CERBER</strong>
        <small>PRIVATE PHOTO</small>
      </span>
    </a>
    <a class="back-link" href="/">Загрузить фото</a>
  </header>
  <main class="photo-view">
    <p id="viewerStatus" class="viewer-status">Проверка приватной ссылки...</p>
    <img id="privatePhoto" alt="Приватное фото" hidden>
  </main>
  <script src="/viewer.js" type="module"></script>
</body>
</html>`;
  send(res, 200, html, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  }, req.method);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const method = String(req.method || "GET").toUpperCase();

    if (["GET", "HEAD"].includes(method) && ["/health", "/api/health"].includes(url.pathname)) {
      const primaryStorage = await checkPrimaryStorage();
      const ok = primaryStorage.status === "ready";
      sendJson(res, ok ? 200 : 503, {
        ok,
        build: appBuild,
        primaryStorage: primaryStorage.status,
        primaryStorageCheckedAt: primaryStorage.checkedAt,
        backup: currentBackupStatus()
      }, method);
      return;
    }

    if (method === "POST" && url.pathname === "/api/upload") {
      if (rejectCrossSite(req, res)) return;
      await handleUpload(req, res);
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/photos\/([a-f0-9]{24}|[a-f0-9]{32})\/session$/);
    if (method === "POST" && sessionMatch) {
      if (rejectCrossSite(req, res)) return;
      await handlePhotoSession(req, res, sessionMatch[1]);
      return;
    }

    const imageMatch = url.pathname.match(/^\/image\/([a-f0-9]{24}|[a-f0-9]{32})$/);
    if (["GET", "HEAD"].includes(method) && imageMatch) {
      await handleImage(req, res, imageMatch[1]);
      return;
    }

    const pageMatch = url.pathname.match(/^\/p\/([a-f0-9]{24}|[a-f0-9]{32})$/);
    if (["GET", "HEAD"].includes(method) && pageMatch) {
      handlePhotoPage(req, res, pageMatch[1]);
      return;
    }

    if (["GET", "HEAD"].includes(method) && (await servePublic(req, res))) return;
    send(res, 404, "Not found", { "cache-control": "no-store" }, method);
  } catch {
    send(res, 500, "Server error", { "cache-control": "no-store" }, req.method);
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.listen(port, () => {
  console.log(`Cerber Anonim Photo listening on port ${port}`);
  if (r2) {
    backupExistingPhotos()
      .catch((error) => console.error("[backup] initial R2 sync failed", error))
      .finally(() => {
        backupInitialCheckComplete = true;
      });
  } else {
    console.warn("[backup] R2 is not configured; photos only exist on the Render disk");
  }
});
