import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.ts";

for (const [status, body, expected] of [
  [401, {code:401, message:"Invalid username or password"}, /账号或密码不匹配/],
  [429, {code:429, message:"Too many login attempts"}, /Too many login attempts/],
  [403, {code:403, message:"Captcha verification required"}, /Captcha verification required/],
  [401, {code:401}, /HTTP 401/],
  [403, {code:403, message:"private-secret-token password=fixture-password https://private.test/raw"}, /HTTP 403/],
  [200, {code:210, message:"請到官網更新最新APP https://private.test/"}, /站点限制当前客户端访问/],
  [200, null, /HTTP 200/],
] as const) {
  test(`login wire rejection ${status} retains safe public reason without storing or leaking credentials`, async () => {
    const oldFetch = globalThis.fetch, oldBridge = globalThis.bridge;
    const writes: string[] = []; let requests = 0;
    globalThis.bridge = { call: async (fn: string, key: string, fallback: unknown) => {
      if (fn === "load_plugin_config") return JSON.stringify({ok:true,value:fallback});
      if (fn === "save_plugin_config") {writes.push(key); return '{"ok":true}';}
      if (fn === "cache.get") return fallback;
      return null;
    }} as typeof globalThis.bridge;
    globalThis.fetch = async (input) => {
      const request = input as Request;
      assert.equal(request.method, "POST"); assert.equal(new URL(request.url).pathname.endsWith("/login"), true);
      requests++;
      return new Response(JSON.stringify(body), {status,headers:{"content-type":"application/json"}});
    };
    try {
      let error: unknown;
      try {await plugin.loginWithPassword({values:{username:"fixture-user",password:"fixture-password"}});} catch (value) {error = value;}
      assert.ok(error instanceof Error); assert.match(error.message, expected);
      for (const secret of ["fixture-user","fixture-password","private-secret-token","https://private.test", "config", "stack-hook"]) assert.equal(error.message.includes(secret), false);
      assert.equal(requests, 1); assert.deepEqual(writes, []);
    } finally {globalThis.fetch = oldFetch; globalThis.bridge = oldBridge;}
  });
}
