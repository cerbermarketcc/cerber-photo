import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "cerber-photo-test-"));
const port = 32100 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const legacyId = "a".repeat(24);

await fs.writeFile(path.join(uploadDir, `${legacyId}.png`), png);
await fs.writeFile(path.join(uploadDir, "photos.json"), JSON.stringify({
  [legacyId]: {
    id: legacyId,
    storedName: `${legacyId}.png`,
    contentType: "image/png",
    size: png.length,
    createdAt: new Date().toISOString()
  }
}));

const child = spawn(process.execPath, ["server.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    UPLOAD_DIR: uploadDir,
    PHOTO_SESSION_SECRET: "test-session-secret-that-is-long-enough-123456",
    ACCESS_RATE_LIMIT: "2",
    ACCESS_RATE_WINDOW_MS: "60000",
    UPLOAD_RATE_LIMIT: "20"
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
  await fs.rm(uploadDir, { recursive: true, force: true });
});

async function upload(content = png, type = "image/png", origin = baseUrl) {
  const form = new FormData();
  form.append("photos", new Blob([content], { type }), "photo.png");
  return fetch(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: { origin },
    body: form
  });
}

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] || "";
}

test("new uploads use a fragment secret and never expose the raw image", async () => {
  const response = await upload();
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.photos.length, 1);

  const shareUrl = new URL(result.photos[0].url, baseUrl);
  const id = shareUrl.pathname.split("/").pop();
  const key = new URLSearchParams(shareUrl.hash.slice(1)).get("key");
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal("imageUrl" in result.photos[0], false);

  const direct = await fetch(`${baseUrl}/image/${id}`);
  assert.equal(direct.status, 404);
  assert.equal(direct.headers.get("cache-control"), "no-store");

  const directWithQueryKey = await fetch(`${baseUrl}/image/${id}?key=${key}`);
  assert.equal(directWithQueryKey.status, 404);

  const wrongSession = await fetch(`${baseUrl}/api/photos/${id}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ key: "wrong-key" })
  });
  assert.equal(wrongSession.status, 404);

  const session = await fetch(`${baseUrl}/api/photos/${id}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ key })
  });
  assert.equal(session.status, 204);
  const cookie = cookieFrom(session);
  assert.ok(cookie.startsWith(`cerber_photo_access_${id}=`));
  assert.ok(session.headers.get("set-cookie").includes(`Path=/image/${id};`));
  assert.match(session.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(session.headers.get("set-cookie"), /SameSite=Strict/i);

  const image = await fetch(`${baseUrl}/image/${id}`, { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

  const db = JSON.parse(await fs.readFile(path.join(uploadDir, "photos.json"), "utf8"));
  assert.notEqual(db[id].accessHash, key);
  assert.equal(JSON.stringify(db).includes(key), false);
});

test("two photo links have independent sessions and can be reopened by another visitor", async () => {
  const photos = [];
  for (let index = 0; index < 2; index++) {
    const uploaded = await (await upload()).json();
    const link = new URL(uploaded.photos[0].url, baseUrl);
    const id = uploaded.photos[0].id;
    const body = JSON.stringify({ key: new URLSearchParams(link.hash.slice(1)).get("key") });
    const response = await fetch(`${baseUrl}/api/photos/${id}/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body
    });
    assert.equal(response.status, 204);
    photos.push({ id, body, cookie: cookieFrom(response) });
  }
  const cookie = photos.map(photo => photo.cookie).join("; ");
  for (const photo of photos) {
    assert.equal((await fetch(`${baseUrl}/image/${photo.id}`, { headers: { cookie } })).status, 200);
    const reopened = await fetch(`${baseUrl}/api/photos/${photo.id}/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: photo.body
    });
    assert.equal(reopened.status, 204);
    assert.equal((await fetch(`${baseUrl}/image/${photo.id}`, { headers: { cookie: cookieFrom(reopened) } })).status, 200);
  }
});

test("legacy public links are revoked without deleting their files", async () => {
  const direct = await fetch(`${baseUrl}/image/${legacyId}`);
  assert.equal(direct.status, 404);
  assert.equal(await fs.stat(path.join(uploadDir, `${legacyId}.png`)).then(() => true), true);

  const recovery = JSON.parse(await fs.readFile(path.join(uploadDir, ".legacy-photo-keys.json"), "utf8"));
  assert.ok(recovery[legacyId]);
  const db = JSON.parse(await fs.readFile(path.join(uploadDir, "photos.json"), "utf8"));
  assert.ok(db[legacyId].accessHash);
  assert.equal("accessToken" in db[legacyId], false);
});

test("cross-site uploads and content-type spoofing are rejected", async () => {
  const crossSite = await upload(png, "image/png", "https://attacker.example");
  assert.equal(crossSite.status, 403);

  const spoofedType = await upload(png, "image/jpeg");
  assert.equal(spoofedType.status, 400);
});

test("access key guessing is rate limited", async () => {
  const id = "b".repeat(32);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/photos/${id}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ key: `wrong-${attempt}` })
    });
    assert.equal(response.status, 404);
  }

  const limited = await fetch(`${baseUrl}/api/photos/${id}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ key: "wrong-3" })
  });
  assert.equal(limited.status, 429);
});

test("path traversal and sensitive files are not publicly readable", async () => {
  const traversal = await fetch(`${baseUrl}/..%2Fserver.js`);
  assert.equal(traversal.status, 404);
  const database = await fetch(`${baseUrl}/photos.json`);
  assert.equal(database.status, 404);
});
