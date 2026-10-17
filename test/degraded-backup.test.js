import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-photo-degraded-r2-test-"));
const appPort = 34200 + Math.floor(Math.random() * 400);
const r2Port = 34700 + Math.floor(Math.random() * 400);
const baseUrl = `http://127.0.0.1:${appPort}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

let r2Requests = 0;
let r2Available = false;
const r2Objects = new Map();
const unavailableR2 = createServer((req, res) => {
  r2Requests += 1;
  const key = new URL(req.url, "http://localhost").pathname;

  if (!r2Available) {
    req.resume();
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/xml" });
      res.end("<Error><Code>ServiceUnavailable</Code></Error>");
    });
    return;
  }

  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      r2Objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"test-etag"' });
      res.end();
    });
    return;
  }

  if (req.method === "HEAD") {
    res.writeHead(r2Objects.has(key) ? 200 : 404);
    res.end();
    return;
  }

  if (req.method === "GET" && r2Objects.has(key)) {
    const body = r2Objects.get(key);
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
    return;
  }

  if (req.method === "DELETE") {
    r2Objects.delete(key);
    res.writeHead(204);
    res.end();
    return;
  }

  req.resume();
  req.on("end", () => {
    res.writeHead(404);
    res.end();
  });
});

await new Promise((resolve) => unavailableR2.listen(r2Port, "127.0.0.1", resolve));

let childErrors = "";
const child = spawn(process.execPath, ["server.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    UPLOAD_DIR: uploadDir,
    PHOTO_SESSION_SECRET: "test-session-secret-that-is-long-enough-123456",
    R2_BUCKET: "degraded-backup-test",
    R2_ENDPOINT: `http://127.0.0.1:${r2Port}`,
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_PREFIX: "cerber-photo",
    R2_FORCE_PATH_STYLE: "true",
    R2_RETRY_MS: "100"
  },
  stdio: ["ignore", "ignore", "pipe"]
});
child.stderr.on("data", (chunk) => {
  childErrors += chunk.toString();
});

async function waitFor(check, message, timeoutMs = 10_000) {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}${childErrors ? `\n${childErrors}` : ""}`);
}

await waitFor(async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  return response.ok;
}, "Test server did not start");

test.after(async () => {
  child.kill();
  await new Promise((resolve) => unavailableR2.close(resolve));
  await fs.rm(uploadDir, { recursive: true, force: true });
});

test("an unavailable R2 backup does not block uploads or local photo access", async () => {
  const form = new FormData();
  form.append("photos", new Blob([png], { type: "image/png" }), "photo.png");
  const upload = await fetch(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: { origin: baseUrl },
    body: form
  });

  assert.equal(upload.status, 201);
  const result = await upload.json();
  assert.equal(result.photos.length, 1);
  const link = new URL(result.photos[0].url, baseUrl);
  const id = result.photos[0].id;
  const key = new URLSearchParams(link.hash.slice(1)).get("key");

  const session = await fetch(`${baseUrl}/api/photos/${id}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ key })
  });
  assert.equal(session.status, 204);
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0] || "";

  const image = await fetch(`${baseUrl}/image/${id}`, { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  const health = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) return null;
    const body = await response.json();
    return body.backup?.status === "degraded" ? body : null;
  }, "Backup did not enter degraded state");

  assert.equal(health.ok, true);
  assert.equal(health.primaryStorage, "ready");
  assert.match(health.primaryStorageCheckedAt, /^\d{4}-\d{2}-\d{2}T/);
  const cachedHealthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(cachedHealthResponse.status, 200);
  const cachedHealth = await cachedHealthResponse.json();
  assert.equal(cachedHealth.primaryStorageCheckedAt, health.primaryStorageCheckedAt);
  assert.equal(health.backup.configured, true);
  assert.equal(health.backup.status, "degraded");
  assert.equal(health.backup.pending, 1);
  assert.match(health.backup.lastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(r2Requests > 0);

  const db = JSON.parse(await fs.readFile(path.join(uploadDir, "photos.json"), "utf8"));
  assert.equal(db[id].id, id);
  assert.ok((await fs.stat(path.join(uploadDir, db[id].storedName))).isFile());

  r2Available = true;
  const recoveredHealth = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) return null;
    const body = await response.json();
    return body.backup?.status === "ready" && body.backup.pending === 0 ? body : null;
  }, "Backup queue did not recover after R2 became available");

  assert.equal(recoveredHealth.backup.status, "ready");
  assert.equal(recoveredHealth.backup.pending, 0);
  assert.match(recoveredHealth.backup.lastSuccessAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r2Objects.size, 2);
});
