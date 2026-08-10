import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const dbPath = path.join(uploadDir, "photos.json");
const port = Number(process.env.PORT || 3000);
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const maxFilesPerUpload = Number(process.env.MAX_FILES_PER_UPLOAD || 20);
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 10 * 1024 * 1024);
let dbWriteQueue = Promise.resolve();

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

const allowedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif"
]);

await fs.mkdir(uploadDir, { recursive: true });

function securityHeaders(extra = {}) {
  return {
    "content-security-policy": "default-src 'self'; img-src 'self' blob: data:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...extra
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, securityHeaders(headers));
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), {
    "content-type": "application/json; charset=utf-8"
  });
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
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeDb(db) {
  const tmpPath = `${dbPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmpPath, dbPath);
}

async function updateDb(mutator) {
  dbWriteQueue = dbWriteQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  return dbWriteQueue;
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxUploadBytes) {
        reject(new Error("Файл слишком большой."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseContentDisposition(value = "") {
  const result = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawVal] = part.trim().split("=");
    if (!rawVal.length) continue;
    result[rawKey] = rawVal.join("=").replace(/^"|"$/g, "");
  }
  return result;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
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
    if (part.subarray(part.length - 2).toString() === "\r\n") {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const rawHeaders = part.subarray(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const headers = Object.fromEntries(
      rawHeaders.split("\r\n").map((line) => {
        const splitAt = line.indexOf(":");
        return [line.slice(0, splitAt).toLowerCase(), line.slice(splitAt + 1).trim()];
      })
    );

    const disposition = parseContentDisposition(headers["content-disposition"]);
    if (disposition.filename && content.length) {
      parts.push({
        filename: disposition.filename,
        contentType: headers["content-type"] || "application/octet-stream",
        content
      });
    }
  }

  return parts;
}

function extensionFor(type, filename) {
  const clean = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"].includes(clean)) return clean;

  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif"
  }[type] || "";
}

function isValidImageSignature(type, content) {
  if (type === "image/jpeg") {
    return content.length > 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  }

  if (type === "image/png") {
    return content.length > 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  if (type === "image/gif") {
    const signature = content.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }

  if (type === "image/webp") {
    return content.length > 12 &&
      content.subarray(0, 4).toString("ascii") === "RIFF" &&
      content.subarray(8, 12).toString("ascii") === "WEBP";
  }

  if (type === "image/avif") {
    return content.length > 12 &&
      content.subarray(4, 8).toString("ascii") === "ftyp" &&
      ["avif", "avis"].includes(content.subarray(8, 12).toString("ascii"));
  }

  return false;
}

async function servePublic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : safeDecode(url.pathname);
  const filePath = path.normalize(path.join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return true;
  }

  try {
    const content = await fs.readFile(filePath);
    send(res, 200, content, {
      "content-type": mimeByExt[path.extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    return true;
  } catch {
    return false;
  }
}

async function handleUpload(req, res) {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.startsWith("multipart/form-data")) {
      sendJson(res, 400, { error: "Нужно отправить фото через форму." });
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

    for (const file of files) {
      if (!allowedTypes.has(file.contentType)) continue;
      if (file.content.length > maxFileBytes) continue;
      if (!isValidImageSignature(file.contentType, file.content)) continue;

      const id = crypto.randomBytes(12).toString("hex");
      const ext = extensionFor(file.contentType, file.filename);
      const storedName = `${id}${ext}`;
      await fs.writeFile(path.join(uploadDir, storedName), file.content);

      records.push({
        id,
        storedName,
        contentType: file.contentType,
        size: file.content.length,
        createdAt: new Date().toISOString()
      });

      created.push({
        id,
        url: `${getBaseUrl(req)}/p/${id}`,
        imageUrl: `${getBaseUrl(req)}/image/${id}`
      });
    }

    if (!created.length) {
      sendJson(res, 400, { error: "Поддерживаются только настоящие JPG, PNG, GIF, WEBP или AVIF фото до 10 MB." });
      return;
    }

    await updateDb((db) => {
      for (const record of records) db[record.id] = record;
    });

    sendJson(res, 201, { photos: created });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Не удалось загрузить фото." });
  }
}

async function handleImage(req, res, id) {
  const db = await readDb();
  const photo = db[id];
  if (!photo) {
    send(res, 404, "Фото не найдено");
    return;
  }

  try {
    const content = await fs.readFile(path.join(uploadDir, photo.storedName));
    send(res, 200, content, {
      "content-type": photo.contentType,
      "content-disposition": "inline",
      "cache-control": "public, max-age=31536000, immutable"
    });
  } catch {
    send(res, 404, "Файл не найден");
  }
}

async function handlePhotoPage(req, res, id) {
  const db = await readDb();
  const photo = db[id];
  if (!photo) {
    send(res, 404, "<h1>Фото не найдено</h1>", { "content-type": "text/html; charset=utf-8" });
    return;
  }

  const imageUrl = `/image/${id}`;
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cerber Anonim Photo</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="viewer">
  <main class="photo-view">
    <a class="back-link" href="/">Загрузить анонимно</a>
    <img src="${imageUrl}" alt="Загруженное фото">
  </main>
</body>
</html>`;
  send(res, 200, html, { "content-type": "text/html; charset=utf-8" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/upload") {
    await handleUpload(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/image/")) {
    await handleImage(req, res, url.pathname.split("/").pop());
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/p/")) {
    await handlePhotoPage(req, res, url.pathname.split("/").pop());
    return;
  }

  if (req.method === "GET" && (await servePublic(req, res))) return;
  send(res, 404, "Not found");
});

server.listen(port, () => {
  console.log(`Cerber Anonim Photo: http://localhost:${port}`);
  console.log(`Uploads: ${uploadDir}`);
});
