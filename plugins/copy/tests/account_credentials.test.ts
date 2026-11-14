import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_CREDENTIALS_KEY, readAccountCredentials, saveAccountCredentials } from "../src/account-credentials.ts";
import plugin from "../src/index.ts";

test("login persists an atomic credential record and restores a prefilled form without login requests", async () => {
  const values = new Map<string, unknown>();
  const cache = new Map<string, unknown>();
  const previousBridge = globalThis.bridge;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  let rejectCredentialWrite = false;
  globalThis.bridge = { call: async (fn: string, key: string, value: unknown) => {
    if (fn === "load_plugin_config") return JSON.stringify({ok: true, value: values.get(key) ?? value});
    if (fn === "save_plugin_config") {
      if (rejectCredentialWrite && key === ACCOUNT_CREDENTIALS_KEY) return '{"ok":false}';
      let parsed: unknown = value;
      try { parsed = JSON.parse(String(value)); } catch {}
      values.set(key, parsed);
      return '{"ok":true}';
    }
    if (fn === "cache.get") return cache.get(key) ?? value;
    if (fn === "cache.set") { cache.set(key, value); return true; }
    return null;
  }} as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    requests++;
    const request = input as Request;
    const clientDeclared = /Mobile.*RSSX/.test(request.headers.get("User-Agent") ?? "");
    if (new URL(request.url).pathname.endsWith("/member/info")) {
      assert.equal(request.method, "GET");
      return new Response(JSON.stringify(clientDeclared
        ? {code:200,results:{user_id:"fixture-member",nickname:"fixture-user"}}
        : {code:210,message:"請到官網更新最新APP"}), {headers:{"content-type":"application/json"}});
    }
    assert.equal(request.method, "POST");
    assert.equal(clientDeclared, true,
      "login must identify the API client, as existing content requests do");
    return new Response(JSON.stringify({code:200,results:{token:"fixture-token"}}), {headers:{"content-type":"application/json"}});
  };
  try {
    await plugin.loginWithPassword({values: {username: "fixture-user", password: "fixture-password"}});
    const record = values.get(ACCOUNT_CREDENTIALS_KEY) as Record<string, unknown>;
    assert.equal(record.version, 1);
    assert.equal(record.deleted, false);
    assert.equal(record.account === "fixture-user" && record.password === "fixture-password", true);
    assert.equal(new URL(String(record.origin)).protocol, "https:");
    assert.equal(Number(record.updatedAt) > 0, true);
    const profile = await plugin.getUserInfoBundle();
    assert.equal(profile.data.extern?.userId, "fixture-member",
      "authenticated profile requests must retain the same client identity");
    const before = requests;
    const bundle = await plugin.getLoginBundle();
    assert.equal(bundle.data.values?.username === "fixture-user" && bundle.data.values?.password === "fixture-password", true);
    assert.equal(requests, before);
    rejectCredentialWrite = true;
    await assert.rejects(plugin.loginWithPassword({values: {username: "fixture-other", password: "fixture-other"}}), /登录资料保存失败/);
    assert.equal((values.get(ACCOUNT_CREDENTIALS_KEY) as Record<string, unknown>).account === "fixture-user", true);
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
});

test("failed durable writes reject, and deletion or incomplete records never restore a password", async () => {
  const failing = {load: async () => '{"ok":true,"value":null}', save: async () => '{"ok":false}'};
  await assert.rejects(saveAccountCredentials(failing, "fixture", "fixture", "https://example.test"), /登录资料保存失败/);
  for (const value of [null, {version:1, deleted:true}, {version:1, account:"fixture", deleted:false}]) {
    assert.equal(await readAccountCredentials({ ...failing, load:async () => JSON.stringify({ok:true,value}) }), null);
  }
  await assert.rejects(saveAccountCredentials({...failing, save:async () => {throw new Error("fixture failure");}}, "fixture", "fixture", "https://example.test"), /登录资料保存失败/);
});

test("account failures are not presented as a cached successful profile", async () => {
  const previousBridge = globalThis.bridge;
  const previousFetch = globalThis.fetch;
  let signedIn = false;
  let requests = 0;
  globalThis.bridge = {call: async (fn: string, key: string, value: unknown) => {
    if (fn === "load_plugin_config") {
      const stored = key === "auth.token" && signedIn ? "fixture-token" : value;
      return JSON.stringify({ok:true,value:stored});
    }
    if (fn === "cache.get") return value;
    return null;
  }} as typeof globalThis.bridge;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({code:210,message:"fixture service unavailable"}),
      {headers:{"content-type":"application/json"}});
  };
  try {
    await assert.rejects(plugin.getUserInfoBundle(), /unauthorized/);
    assert.equal(requests, 0);
    signedIn = true;
    await assert.rejects(plugin.getUserInfoBundle(), /无法读取拷贝账号资料/);
    assert.equal(requests, 1);
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
});
