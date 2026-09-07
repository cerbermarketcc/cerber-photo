import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-photo-r2-test-"));
const appPort = 33200 + Math.floor(Math.random() * 500);
const r2Port = 33700 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${appPort}`;
const objects = new Map();
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const fakeR2 = createServer((req, res) => {
  const key = new URL(req.url, "http://localhost").pathname;
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"test-etag"' });
      res.end();
    });
    return;
  }
  if (req.method === "HEAD") {
    res.writeHead(objects.has(key) ? 200 : 404, objects.has(key) ? { "content-length": objects.get(key).length } : {});
    res.end();
    return;
  }
  if (req.method === "GET" && objects.has(key)) {
    const body = objects.get(key);
    res.writeHead(200, { "content-length": body.length, "content-type": key.endsWith(".json") ? "application/json" : "image/png" });
    res.end(body);
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => fakeR2.listen(r2Port, "127.0.0.1", resolve));

const child = spawn(process.execPath, ["server.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(appPort),
    UPLOAD_DIR: uploadDir,
    PHOTO_SESSION_SECRET: "test-session-secret-that-is-long-enough-123456",
    R2_BUCKET: "backup-test",
    R2_ENDPOINT: `http://127.0.0.1:${r2Port}`,
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_PREFIX: "cerber-photo",
    R2_FORCE_PATH_STYLE: "true"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

async function waitForServer() {
  const timeoutAt = Date.now() + 10_000;
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start");
}

await waitForServer();

test.after(async () => {
  child.kill();
  await new Promise((resolve) => fakeR2.close(resolve));
  await fs.rm(uploadDir, { recursive: true, force: true });
});

test("R2 backup restores the database record and photo while preserving its link", async () => {
  const form = new FormData();
  form.append("photos", new Blob([png], { type: "image/png" }), "photo.png");
  const upload = await fetch(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: { origin: baseUrl },
    body: form
  });
  assert.equal(upload.status, 201);
  const result = await upload.json();
  const link = result.photos[0].url;
  const match = link.match(/^\/p\/([a-f0-9]{32})#key=([A-Za-z0-9_-]{43})$/);
  assert.ok(match);
  const [, id, key] = match;

  const db = JSON.parse(await fs.readFile(path.join(uploadDir, "photos.json"), "utf8"));
  await fs.unlink(path.join(uploadDir, db[id].storedName));
  await fs.unlink(path.join(uploadDir, "photos.json"));

  const session = await fetch(`${baseUrl}/api/photos/${id}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ key })
  });
  assert.equal(session.status, 204);
  const cookie = session.headers.get("set-cookie").split(";", 1)[0];

  const image = await fetch(`${baseUrl}/image/${id}`, { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  assert.ok((await fs.stat(path.join(uploadDir, "photos.json"))).isFile());
  assert.ok((await fs.stat(path.join(uploadDir, db[id].storedName))).isFile());
});
