import test from "node:test";
import assert from "node:assert/strict";
import {
  CopyAvatarSubmittedError,
  createCopyAvatarHelper,
  COPY_AVATAR_LIMIT,
  type CopyProfileRequest,
  type CopyAvatarImage,
} from "../src/profile-avatar.ts";
import { buildPluginInfo } from "../src/get-info.ts";

const image: CopyAvatarImage = {
  bytes: Uint8Array.from([255, 216, 255, 224]),
  mime: "image/jpeg",
  filename: "my-avatar.jpg",
};
const snapshot = (
  avatar = "https://images.example/old.jpg",
  extra: Record<string, unknown> = {},
) => ({
  code: 200,
  results: {
    info: {
      username: "fixture-account",
      nickname: "Existing nickname",
      avatar,
      gender: { value: 2 },
      blood: { value: "AB" },
      datetime_birthday: "2000-02-29T13:15:00",
      ...extra,
    },
  },
});
function fixture(responses: unknown[]) {
  const calls: CopyProfileRequest[] = [];
  return {
    calls,
    helper: createCopyAvatarHelper(async (request) => {
      calls.push(request);
      const reply = responses.shift();
      if (reply instanceof Error) throw reply;
      assert.notEqual(reply, undefined, "unexpected protocol request");
      return reply;
    }, "fixture-token"),
  };
}

test("avatar update reads first, uploads bytes, preserves profile fields, and confirms by independent read", async () => {
  const { helper, calls } = fixture([
    snapshot(),
    { code: 200, results: "opaque/upload-handle" },
    { code: 200 },
    snapshot("https://images.example/new.jpg"),
  ]);
  const result = await helper.update(image);
  assert.equal(result?.avatar, "https://images.example/new.jpg");
  assert.deepEqual(
    calls.map((c) => [new URL(c.url).pathname, c.method]),
    [
      ["/api/v2/web/user/update/info", "GET"],
      ["/api/v1/upload/image", "POST"],
      ["/api/v2/web/me/edit", "POST"],
      ["/api/v2/web/user/update/info", "GET"],
    ],
  );
  assert.ok(calls.every((c) => new URL(c.url).origin === "https://2026copy.com"));
  assert.deepEqual(calls[1].body, { kind: "multipart", field: "file", image });
  assert.equal(
    calls[1].headers["Content-Type"],
    undefined,
    "multipart transport must own boundary",
  );
  assert.equal(
    calls[1].headers.platform,
    undefined,
    "official direct upload only declares authorization",
  );
  assert.equal(calls[2].headers.platform, "2");
  assert.deepEqual(calls[2].body, {
    kind: "form",
    values: {
      nickname: "Existing nickname",
      gender: "2",
      blood: "AB",
      birthday: "2000-02-29",
      avatar: "opaque/upload-handle",
    },
  });
});

test("cancelled selection and invalid bytes perform no requests", async () => {
  const { helper, calls } = fixture([]);
  assert.equal(await helper.update(null), null);
  for (const bad of [
    { ...image, bytes: new Uint8Array() },
    { ...image, bytes: new Uint8Array(COPY_AVATAR_LIMIT + 1) },
    { ...image, mime: "image/gif" } as CopyAvatarImage,
    { ...image, mime: "image/png" } as CopyAvatarImage,
    { ...image, filename: "bad\r\nname.jpg" },
  ])
    await assert.rejects(helper.update(bad));
  assert.equal(calls.length, 0);
});

test("PNG and JPEG at the avatar page limit are accepted; invalid birthday is never sent", async () => {
  for (const candidate of [
    {
      bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mime: "image/png",
      filename: "avatar.png",
    },
    {
      bytes: Uint8Array.from({ length: COPY_AVATAR_LIMIT }, (_, i) => image.bytes[i] ?? 0),
      mime: "image/jpeg",
      filename: "large.jpg",
    },
  ] as CopyAvatarImage[]) {
    const { helper, calls } = fixture([
      snapshot(undefined, { datetime_birthday: "2001-02-29" }),
      { code: 200, results: "handle" },
      { code: 200 },
      snapshot("https://images.example/new.jpg"),
    ]);
    await helper.update(candidate);
    assert.equal(calls[2].body?.kind, "form");
    if (calls[2].body?.kind === "form") assert.equal("birthday" in calls[2].body.values, false);
  }
});

test("incomplete or unauthorized reads stop before upload", async () => {
  for (const response of [
    snapshot(undefined, { nickname: null }),
    snapshot(undefined, { gender: { display: "unknown" } }),
    { code: 401 },
  ]) {
    const { helper, calls } = fixture([response]);
    await assert.rejects(helper.update(image));
    assert.equal(calls.length, 1);
  }
});

test("upload failure or invalid handle never saves profile", async () => {
  for (const response of [
    { code: 500, message: "private-data" },
    { code: 200, results: {} },
    { code: 200, results: "" },
    new Error("transport failed"),
  ]) {
    const { helper, calls } = fixture([snapshot(), response]);
    await assert.rejects(helper.update(image));
    assert.equal(calls.length, 2);
  }
});

test("save failure does not report success or read an apparently successful profile", async () => {
  const { helper, calls } = fixture([
    snapshot(),
    { code: 200, results: "handle" },
    { code: 400, message: "private-data" },
  ]);
  await assert.rejects(helper.update(image), /保存头像失败/);
  assert.equal(calls.length, 3);
});

test("unchanged avatar, changed account, or failed confirmation never reports success", async () => {
  for (const response of [
    snapshot(),
    snapshot("new-url", { username: "other-account" }),
    { code: 500 },
  ]) {
    const { helper } = fixture([
      snapshot(),
      { code: 200, results: "handle" },
      { code: 200 },
      response,
    ]);
    await assert.rejects(helper.update(image), CopyAvatarSubmittedError);
  }
});

test("verified avatar protocol declares the shared upload entry", () => {
  assert.equal(buildPluginInfo().breezeExperience.profileAvatarFunction, "updateAvatar");
  assert.equal("uploadAvatar" in buildPluginInfo(), false);
});

test("settings separate concise labels from explanations without changing values or save paths", async () => {
  const { default: plugin } = await import("../src/index.ts");
  const oldBridge = globalThis.bridge;
  globalThis.bridge = {
    call: async (fn: string, _key: string, value: unknown) => {
      if (fn === "load_plugin_config") return JSON.stringify({ ok: true, value });
      if (fn === "cache.get") return value;
      return true;
    },
  } as typeof globalThis.bridge;
  try {
    const bundle = await plugin.getSettingsBundle();
    const fields = bundle.scheme.sections[0].fields as Array<{
      key: string;
      label: string;
      description?: string;
      fnPath?: string;
      options?: Array<{ value: unknown }>;
    }>;
    assert.deepEqual(
      fields.map((f) => [f.key, f.label, f.fnPath]),
      [
        ["api.domain", "访问线路", "saveSettings"],
        ["api.platform", "请求标识", "saveSettings"],
      ],
    );
    assert.match(fields[0].description ?? "", /目录、公开详情和章节列表.*测速通过后，再选耗时最短的线路.*详情和首批章节.*封面和账号各自连接/);
    assert.match(fields[1].description ?? "", /默认用 1.*测速沿用当前值.*账号请求固定用 1/);
    assert.ok(fields[1].description?.includes("客户端"));
    assert.deepEqual(
      fields[1].options?.map((o) => o.value),
      ["1", "2", "3", "4", "5", "", " "],
    );
    assert.equal(bundle.data.values?.["api.platform"], "1");
    assert.equal(bundle.data.values?.["api.domain"], "大陆专线2");
  } finally {
    globalThis.bridge = oldBridge;
  }
});


test("uncertain save transport result is submitted and must never offer a repeated write", async () => {
  const { helper, calls } = fixture([
    snapshot(), { code: 200, results: "opaque/upload-handle" }, new Error("fixture timeout"),
  ]);
  await assert.rejects(helper.update(image), CopyAvatarSubmittedError);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((request) => request.method === "POST").length, 2);
});
