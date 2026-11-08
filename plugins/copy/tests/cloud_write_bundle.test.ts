import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type sourcePlugin from "../src/index.ts";

// Exercise the distributable and its bundled ky through the real Request constructor.
// A source helper mock would miss the string-body text/plain default behind the bug.
const plugin = createRequire(import.meta.url)("../dist/breeze-plugin-copy-comic.bundle.cjs")
  .default as typeof sourcePlugin;
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const isForm = (request: Request) =>
  /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "");
const member = (updated = false) => ({
  code: 200,
  results: {
    info: {
      username: "fixture-user",
      nickname: "测试 & + nickname",
      avatar: `https://images.example/${updated ? "new" : "old"}.jpg`,
      gender: { value: 1 },
      blood: { value: "O" },
      datetime_birthday: "1990-05-06 00:00:00",
    },
  },
});

async function withRuntime(
  run: (calls: Request[], state: { token: string; rejectWrite: boolean }) => Promise<void>,
) {
  const oldFetch = globalThis.fetch;
  const oldBridge = globalThis.bridge;
  const calls: Request[] = [];
  const values = new Map<string, unknown>();
  const state = { token: "fixture-token", rejectWrite: false };
  let saved = false;
  globalThis.bridge = {
    call: async (fn: string, key: string, value: unknown) => {
      if (fn === "load_plugin_config")
        return JSON.stringify({
          ok: true,
          value: key === "auth.token" ? state.token : (values.get(key) ?? value),
        });
      if (fn === "save_plugin_config") {
        let parsed = value;
        try {
          parsed = JSON.parse(String(value));
        } catch {
          // Auth token uses the kit's raw-string config contract.
        }
        values.set(key, parsed);
        return '{"ok":true}';
      }
      if (fn === "cache.get") return value;
      return null;
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    const request = input as Request;
    calls.push(request.clone());
    const path = new URL(request.url).pathname;
    if (
      path.endsWith("/collect/comic") ||
      path.endsWith("/collect/comics") ||
      path.endsWith("/login") ||
      path.endsWith("/me/edit")
    ) {
      if (!isForm(request))
        return json({
          code: 415,
          message: `Unsupported media type "${request.headers.get("content-type")}" in request.`,
        });
      if (state.rejectWrite) return json({ code: 400, message: "fixture rejected write" });
    }
    if (path.endsWith("/query")) return json({ code: 200, results: { collect: 37 } });
    if (path.includes("/comic2/"))
      return json({ code: 200, results: { comic: { uuid: "fixture-comic-uuid" } } });
    if (path.endsWith("/collect/comic") || path.endsWith("/collect/comics"))
      return json({ code: 200 });
    if (path.endsWith("/login")) return json({ code: 200, results: { token: "fixture-token" } });
    if (path.endsWith("/update/info")) return json(member(saved));
    if (path.endsWith("/upload/image")) return json({ code: 200, results: "opaque & + handle" });
    if (path.endsWith("/me/edit")) {
      saved = true;
      return json({ code: 200 });
    }
    if (path.endsWith("/member/info"))
      return json({ code: 200, results: { user_id: "fixture-id", username: "fixture-user" } });
    throw new Error(`Unexpected offline fixture request: ${request.method} ${path}`);
  };
  try {
    await run(calls, state);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.bridge = oldBridge;
  }
}

test("built CJS cloud add sends form media type and fields instead of text/plain", async () => {
  await withRuntime(async (calls) => {
    const result = await plugin.startFavoriteAction({ comicId: "fixture-comic", action: "add" });
    assert.equal(result.status, "completed", result.message);
    assert.equal(result.committed, true);
    assert.equal(result.favorited, true);
    assert.equal(calls.length, 2);
    const request = calls[1];
    const url = new URL(request.url);
    assert.equal(request.method, "POST");
    assert.equal(url.pathname, "/api/v3/member/collect/comic");
    assert.equal(url.search, "?platform=1");
    assert.equal(request.headers.get("authorization"), "Token fixture-token");
    assert.equal(isForm(request), true);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), {
      comic_id: "fixture-comic-uuid",
      is_collect: "1",
    });
  });
});

for (const action of ["removeAll", "removeFromTarget"] as const) {
  test(`built CJS ${action} keeps DELETE form media type and collection ID`, async () => {
    await withRuntime(async (calls) => {
      const result = await plugin.startFavoriteAction({
        comicId: "fixture-comic",
        action,
        context: { target: { id: "37" } },
      });
      assert.equal(result.status, "completed", result.message);
      assert.equal(result.committed, true);
      const writes = calls.filter((request) => request.method === "DELETE");
      assert.equal(writes.length, 1);
      const request = writes[0];
      assert.equal(new URL(request.url).pathname, "/api/v3/member/collect/comics");
      assert.equal(request.headers.get("authorization"), "Token fixture-token");
      assert.equal(isForm(request), true);
      assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), {
        ids: "37",
      });
    });
  });
}

test("built CJS login keeps encoded form fields and its explicit media type", async () => {
  await withRuntime(async (calls) => {
    await plugin.loginWithPassword({
      values: { username: "fixture + & 用户", password: "p + & =" },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(new URL(calls[0].url).pathname, "/api/v3/login");
    assert.equal(isForm(calls[0]), true);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await calls[0].text())), {
      username: "fixture + & 用户",
      password: Buffer.from("p + & =-1729").toString("base64"),
      salt: "1729",
    });
  });
});

test("built CJS avatar upload stays multipart while profile save stays encoded form", async () => {
  await withRuntime(async (calls) => {
    const bytes = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70]);
    const result = await plugin.updateAvatar({ jpegBase64: Buffer.from(bytes).toString("base64") });
    assert.equal(result.ok, true);
    const writes = calls.filter((request) => request.method === "POST");
    assert.equal(writes.length, 2);
    const [upload, edit] = writes;
    assert.equal(new URL(upload.url).pathname, "/api/v1/upload/image");
    assert.match(upload.headers.get("content-type")!, /^multipart\/form-data; boundary=/);
    const file = (await upload.formData()).get("file") as File;
    assert.equal(file.name, "avatar.jpg");
    assert.equal(file.type, "image/jpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    assert.equal(new URL(edit.url).pathname, "/api/v2/web/me/edit");
    assert.equal(isForm(edit), true);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await edit.text())), {
      nickname: "测试 & + nickname",
      gender: "1",
      blood: "O",
      avatar: "opaque & + handle",
      birthday: "1990-05-06",
    });
    for (const request of writes) {
      assert.equal(new URL(request.url).origin, "https://2026copy.com");
      assert.equal(request.headers.get("authorization"), "Token fixture-token");
      assert.equal(request.headers.has("cookie"), false);
    }
  });
});

test("built CJS does not commit rejected cloud writes or issue them without a login", async () => {
  await withRuntime(async (calls, state) => {
    state.rejectWrite = true;
    for (const action of ["add", "removeAll"] as const) {
      const result = await plugin.startFavoriteAction({ comicId: "fixture-comic", action });
      assert.equal(result.status, "failed");
      assert.equal(result.committed, false);
    }
    assert.equal(calls.filter((request) => ["POST", "DELETE"].includes(request.method)).length, 2);
    calls.length = 0;
    state.token = "";
    const result = await plugin.startFavoriteAction({ comicId: "fixture-comic", action: "add" });
    assert.equal(result.status, "failed");
    assert.equal(result.committed, false);
    assert.equal(calls.length, 0);
  });
});
