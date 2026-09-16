import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/viewer.js", import.meta.url), "utf8");

async function openViewer(status = 204) {
  const fragment = "#key=" + "a".repeat(43);
  const location = { hash: fragment };
  const photo = { hidden: true, addEventListener() {} };
  const message = {};
  let posted;
  const ctx = vm.createContext({
    URLSearchParams,
    window: { location },
    history: { replaceState() { location.hash = ""; } },
    document: { body: { dataset: { photoId: "b".repeat(32) } }, querySelector: selector => selector === "#privatePhoto" ? photo : message },
    fetch: async (_url, options) => { posted = JSON.parse(options.body); return { ok: status < 400, status }; }
  });
  await vm.runInContext(source, ctx);
  return { location, fragment, posted, photo, message };
}

test("opening a photo retains the full shareable URL and sends the fragment key", async () => {
  const result = await openViewer();
  assert.equal(result.location.hash, result.fragment);
  assert.equal(result.posted.key, "a".repeat(43));
  assert.equal(result.photo.src, "/image/" + "b".repeat(32));
});

test("temporary storage failures are not reported as deleted photos", async () => {
  const result = await openViewer(503);
  assert.match(result.message.textContent, /временно/);
  assert.equal(result.location.hash, result.fragment);
  assert.equal(result.photo.src, undefined);
});
