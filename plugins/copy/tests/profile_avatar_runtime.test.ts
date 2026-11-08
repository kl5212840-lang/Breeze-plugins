import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.ts";
import { prepareCopyAvatarJpeg, copyProfileTransport } from "../src/profile-avatar-runtime.ts";
import { COPY_AVATAR_LIMIT } from "../src/profile-avatar.ts";

const bytes = Uint8Array.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
const base64 = Buffer.from(bytes).toString("base64");
const profile = (updated = false) => ({
  code: 200,
  results: {
    info: {
      username: "fixture-account",
      nickname: "Original name",
      avatar: updated ? "https://images.example/new.jpg" : "https://images.example/old.jpg",
      gender: { value: 1 },
      blood: { value: "O" },
      datetime_birthday: "1990-05-06 00:00:00",
    },
  },
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function withRuntime(
  run: (
    calls: Request[],
    state: {
      saved: boolean;
      status: number;
      token: string;
      memberUsername: string;
      confirmation: "ok" | "fail" | "unchanged";
    },
  ) => Promise<void>,
) {
  const oldFetch = globalThis.fetch,
    oldBridge = globalThis.bridge;
  const calls: Request[] = [];
  const state = {
    saved: false,
    status: 200,
    token: "fixture-token",
    memberUsername: "fixture-account",
    confirmation: "ok" as "ok" | "fail" | "unchanged",
  };
  globalThis.bridge = {
    call: async (fn: string, key: string, fallback: unknown) => {
      if (fn === "load_plugin_config")
        return JSON.stringify({ ok: true, value: key === "auth.token" ? state.token : fallback });
      return null;
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    const request = input as Request;
    calls.push(request.clone());
    if (state.status !== 200)
      return json({ code: state.status, message: "private account/token payload" }, state.status);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/member/info")) return json({ code: 200, results: {
      user_id: "fixture-member", username: state.memberUsername, nickname: "Original name",
      avatar: "https://images.example/old.jpg",
    } });
    if (path.endsWith("/update/info"))
      return state.saved && state.confirmation === "fail"
        ? json({ code: 503 }, 503)
        : json(profile(state.saved && state.confirmation !== "unchanged"));
    if (path.endsWith("/upload/image")) return json({ code: 200, results: "opaque-server-handle" });
    if (path.endsWith("/me/edit")) {
      state.saved = true;
      return json({ code: 200 });
    }
    throw new Error("Unexpected test request");
  };
  try {
    await run(calls, state);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.bridge = oldBridge;
  }
}

test("real wrapper serializes multipart JPEG bytes, preserves fields, and confirms before success", async () => {
  await withRuntime(async (calls) => {
    const result = await plugin.updateAvatar({ jpegBase64: base64 });
    assert.equal(result.ok, true);
    assert.equal("confirmed" in result && result.confirmed, true);
    assert.equal("profile" in result && result.profile.data.avatar.url, "https://images.example/new.jpg");
    assert.equal("profile" in result && result.profile.data.extern?.userId, "fixture-member");
    assert.match("profile" in result ? result.profile.data.avatar.path : "", /new\.jpg/);
    assert.equal(calls.length, 5);
    for (const req of calls.slice(0, 4)) {
      assert.equal(new URL(req.url).origin, "https://2026copy.com");
      assert.equal(req.credentials, "omit");
      assert.equal(req.redirect, "error");
      assert.equal(req.headers.has("cookie"), false);
      assert.equal(req.headers.get("authorization"), "Token fixture-token");
    }
    const form = await calls[1].formData();
    const file = form.get("file") as File;
    assert.equal(file.name, "avatar.jpg");
    assert.equal(file.type, "image/jpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
    assert.deepEqual([...form.keys()], ["file"]);
    assert.match(calls[1].headers.get("content-type")!, /^multipart\/form-data; boundary=/);
    const edit = new URLSearchParams(await calls[2].text());
    assert.deepEqual(Object.fromEntries(edit), {
      nickname: "Original name",
      gender: "1",
      blood: "O",
      avatar: "opaque-server-handle",
      birthday: "1990-05-06",
    });
  });
});

test("wrapper rejects malformed, oversized or non-JPEG input before requests and handles cancellation", async () => {
  await withRuntime(async (calls, state) => {
    for (const value of [
      null,
      "",
      "a",
      "abcd====",
      "AB==",
      "data:image/jpeg;base64," + base64,
      "iVBORw0KGgo=",
      "A".repeat(Math.ceil(COPY_AVATAR_LIMIT / 3) * 4 + 4),
    ]) {
      await assert.rejects(plugin.updateAvatar({ jpegBase64: value }));
    }
    const exactLimit = new Uint8Array(COPY_AVATAR_LIMIT);
    exactLimit.set(bytes);
    await assert.rejects(
      plugin.updateAvatar({ jpegBase64: Buffer.from(exactLimit).toString("base64") }),
    );
    assert.deepEqual(await plugin.updateAvatar({ cancelled: true }), {
      ok: false,
      cancelled: true,
    });
    state.token = "";
    await assert.rejects(plugin.updateAvatar({ jpegBase64: base64 }), /请先登录/);
    assert.equal(calls.length, 0);
  });
});

test("failed request is not retried and never leaks remote account fields", async () => {
  await withRuntime(async (calls, state) => {
    state.status = 503;
    await assert.rejects(plugin.updateAvatar({ jpegBase64: base64 }), (error) => {
      assert.match(String(error), /网络请求失败/);
      assert.doesNotMatch(String(error), /private|fixture-token/);
      return true;
    });
    assert.equal(calls.length, 1);
  });
});

test("transport rejects alternate origins and unexpected paths before invoking fetch", async () => {
  await withRuntime(async (calls) => {
    for (const url of [
      "https://other.example/api/v1/upload/image",
      "http://2026copy.com/api/v1/upload/image",
      "https://2026copy.com/api/v1/logout",
      "https://2026copy.com/api/v1/upload/image?redirect=x",
    ]) {
      await assert.rejects(copyProfileTransport({ url, method: "POST", headers: {} }));
    }
    assert.equal(calls.length, 0);
  });
});

test("base64 decoder accepts just-under-limit canonical JPEG without a Node runtime dependency", () => {
  const large = new Uint8Array(COPY_AVATAR_LIMIT - 1);
  large.set(bytes);
  assert.deepEqual(prepareCopyAvatarJpeg(Buffer.from(large).toString("base64")).bytes, large);
});

for (const confirmation of ["fail", "unchanged"] as const) {
  test(`successful save with ${confirmation} confirmation returns submitted without retrying writes`, async () => {
    await withRuntime(async (calls, state) => {
      state.confirmation = confirmation;
      const result = await plugin.updateAvatar({ jpegBase64: base64 });
      assert.equal(result.ok, false);
      assert.equal("submitted" in result && result.submitted, true);
      assert.match("message" in result ? result.message : "", /头像已提交/);
      assert.equal(
        calls.filter((req) => new URL(req.url).pathname.endsWith("/upload/image")).length,
        1,
      );
      assert.equal(calls.filter((req) => new URL(req.url).pathname.endsWith("/me/edit")).length, 1);
      assert.equal(calls.filter((req) => req.method === "GET").length, 2);
      assert.equal(calls.length, 4, "confirmation failure must not trigger another upload or save");
    });
  });
}


test("profile refresh uses the official web avatar even when app member info is stale", async () => {
  await withRuntime(async (calls, state) => {
    const before = await plugin.getUserInfoBundle();
    state.saved = true;
    const after = await plugin.getUserInfoBundle();
    assert.equal(before.data.avatar.url, "https://images.example/old.jpg");
    assert.equal(after.data.avatar.url, "https://images.example/new.jpg");
    assert.notEqual(before.data.avatar.path, after.data.avatar.path,
      "changed avatar must produce a new disk/decoded image identity");
    assert.equal(calls.filter((r) => r.method === "POST").length, 0);
    for (const request of calls.filter((r) => new URL(r.url).pathname.endsWith("/update/info")))
      assert.equal(request.cache, "no-store");
  });
});


test("a different member account cannot receive a confirmed avatar or overwrite its profile", async () => {
  await withRuntime(async (_calls, state) => {
    state.memberUsername = "fixture-other-account";
    const result = await plugin.updateAvatar({ jpegBase64: base64 });
    assert.equal(result.ok, false);
    assert.equal("submitted" in result && result.submitted, true);
    const current = await plugin.getUserInfoBundle();
    assert.equal(current.data.avatar.url, "https://images.example/old.jpg",
      "an official web result for a different account must not enter the current profile");
  });
});
