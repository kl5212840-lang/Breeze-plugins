import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import client from "../src/client";
import { beginBikaAuthChange, checkInToday } from "../src/bika-checkin";
import {
  clearPluginSession,
  loginWithPassword,
  runBikaAuthAndCheckInLoop,
  updatePassword,
} from "../src/bika-settings";

// Offline adapters and delayed bridge writes exercise the real authorization,
// request sanitization and persistence boundaries without user data or sockets.
const config = new Map<string, unknown>();
const cache = new Map<string, unknown>();
const requests: InternalAxiosRequestConfig[] = [];
const writes: Array<{ key: string; value: unknown }> = [];
const checkinNotices: Array<{ name: string; payload: unknown }> = [];
let respond: (request: InternalAxiosRequestConfig) => Promise<unknown>;
let beforeSave: (key: string, value: unknown) => Promise<void>;
let beforeLoad: (key: string) => Promise<void>;
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto,
  uuidv4: nodeCrypto.randomUUID,
  bridge: {
    async call(name: string, ...args: unknown[]) {
      const key = String(args[0]);
      if (name === "load_plugin_config") {
        await beforeLoad(key);
        return { ok: true, value: config.has(key) ? config.get(key) : JSON.parse(String(args[1])) };
      }
      if (name === "save_plugin_config") {
        const value = JSON.parse(String(args[1]));
        writes.push({ key, value });
        await beforeSave(key, value);
        config.set(key, value);
        return { ok: true };
      }
      if (name === "cache.get") return cache.has(key) ? cache.get(key) : args[1];
      if (name === "cache.set") {
        cache.set(key, args[1]);
        return;
      }
      if (name === "cache.delete") {
        cache.delete(key);
        return;
      }
      if (name === "flutter.showToast" || name === "breeze.checkin.completed") {
        checkinNotices.push({ name, payload: JSON.parse(String(args[0])) });
        return;
      }
      throw new Error(`Unexpected fixture bridge operation ${name}`);
    },
  },
});
const originalAdapter = client.defaults.adapter;
beforeEach(() => {
  beginBikaAuthChange();
  config.clear();
  cache.clear();
  requests.length = 0;
  writes.length = 0;
  checkinNotices.length = 0;
  beforeSave = async () => {};
  beforeLoad = async () => {};
  respond = async (request) =>
    path(request) === "/auth/sign-in"
      ? { code: 200, data: { token: "fixture-new-token" } }
      : { code: 200, data: { user: { _id: "fixture-user", isPunched: true } } };
  client.defaults.adapter = async (request) => {
    requests.push(request);
    return {
      data: await respond(request),
      status: 200,
      statusText: "fixture",
      headers: {},
      config: request,
    };
  };
});
after(() => {
  client.defaults.adapter = originalAdapter;
});
const path = (request: InternalAxiosRequestConfig) => new URL(request.url!).pathname;
function credentials() {
  config.set("auth.account", "fixture@example.invalid");
  config.set("auth.password", "fixture-password");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("logout cannot be crossed by a delayed login token write", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  beforeSave = async (key, value) => {
    if (key === "auth.authorization" && value === "fixture-new-token") {
      entered.resolve();
      await release.promise;
    }
  };
  const login = loginWithPassword({
    account: "fixture@example.invalid",
    password: "fixture-password",
  }).catch((error) => error);
  await entered.promise;
  const logout = clearPluginSession();
  await setImmediate();
  release.resolve();
  const [result] = await Promise.all([login, logout]);
  assert.match(result.message, /账号已变化/);
  for (const key of ["auth.account", "auth.password", "auth.authorization"])
    assert.equal(config.get(key), "");
});

test("a logical credential refusal stops automatic work after one request", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  credentials();
  respond = async () => ({ code: 400, message: "email or password not match" });
  const flow = runBikaAuthAndCheckInLoop();
  try {
    await setImmediate();
    context.mock.timers.tick(600_000);
    await setImmediate();
    assert.equal(requests.length, 1);
    assert.deepEqual(writes, []);
  } finally {
    // Let the pre-fix unbounded loop exit too, keeping the failing reproduction
    // finite and preventing a real timeout from leaking into later tests.
    config.delete("auth.account");
    config.delete("auth.password");
    context.mock.timers.tick(600_000);
    await flow;
  }
});

function httpFailure(request: InternalAxiosRequestConfig, status: number) {
  return new AxiosError("fixture HTTP failure", "ERR_BAD_RESPONSE", request, undefined, {
    data: { message: "fixture-password fixture@example.invalid fixture-private-token" },
    status,
    statusText: "fixture",
    headers: {},
    config: request,
  });
}

for (const failure of [429, 503, "ECONNABORTED"]) {
  test(`automatic transient login has three total attempts and stops (${failure})`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    credentials();
    respond = async (request) => {
      throw typeof failure === "number"
        ? httpFailure(request, failure)
        : new AxiosError("fixture timeout", failure, request);
    };
    const flow = runBikaAuthAndCheckInLoop();
    await setImmediate();
    assert.equal(requests.length, 1);
    context.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(requests.length, 2);
    context.mock.timers.tick(2000);
    await flow;
    assert.equal(requests.length, 3);
    context.mock.timers.tick(600_000);
    await setImmediate();
    assert.equal(requests.length, 3);
    assert.deepEqual(writes, []);
  });
}

for (const failure of [400, 401, 403, "ERR_CANCELED", "UNKNOWN"]) {
  test(`automatic permanent or unknown login failure never retries (${failure})`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    credentials();
    respond = async (request) => {
      throw typeof failure === "number"
        ? httpFailure(request, failure)
        : new AxiosError("fixture failure", failure, request);
    };
    await runBikaAuthAndCheckInLoop();
    context.mock.timers.tick(600_000);
    await setImmediate();
    assert.equal(requests.length, 1);
    assert.deepEqual(writes, []);
  });
}

test("transient errors remain safe objects and use codes rather than matching message text", async () => {
  config.set("auth.authorization", "fixture-private-token");
  for (const code of [
    "ECONNABORTED",
    "ETIMEDOUT",
    "ERR_NETWORK",
    "ECONNRESET",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ERR_CANCELED",
    "UNKNOWN",
  ]) {
    respond = async (request) => {
      throw new AxiosError(
        "fixture@example.invalid fixture-password fixture-private-token",
        code,
        request,
      );
    };
    await assert.rejects(
      loginWithPassword({ account: "fixture@example.invalid", password: "fixture-password" }),
      (error: unknown) => {
        const safe = error as Error & { retryable?: boolean };
        assert.equal(safe.retryable, !["ERR_CANCELED", "UNKNOWN"].includes(code));
        assert.equal(safe.name, "BikaRequestError");
        assert.doesNotMatch(
          safe.message + JSON.stringify(safe),
          /fixture-password|fixture@example|fixture-private-token/,
        );
        assert.ok(
          !("cause" in safe) &&
            !("config" in safe) &&
            !("request" in safe) &&
            !("response" in safe),
        );
        return true;
      },
    );
  }
  respond = async () => {
    throw new Error("network timeout message without a known error code");
  };
  await assert.rejects(
    loginWithPassword({ account: "fixture@example.invalid", password: "fixture-password" }),
    (error: unknown) => {
      assert.equal((error as { retryable: boolean }).retryable, false);
      return true;
    },
  );
});

test("transient login can recover while the verified already-signed path remains unchanged", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  credentials();
  let logins = 0;
  respond = async (request) => {
    if (path(request) === "/auth/sign-in") {
      if (++logins === 1) throw httpFailure(request, 503);
      return { code: 200, data: { token: "fixture-new-token" } };
    }
    return { code: 200, data: { user: { _id: "fixture-user", isPunched: true } } };
  };
  const flow = runBikaAuthAndCheckInLoop();
  await setImmediate();
  context.mock.timers.tick(1000);
  await flow;
  assert.deepEqual(requests.map(path), ["/auth/sign-in", "/auth/sign-in", "/users/profile"]);
  assert.equal(config.get("auth.authorization"), "fixture-new-token");
});

test("concurrent automatic callers share one in-flight login and check-in", async () => {
  credentials();
  const gate = deferred<unknown>();
  respond = async (request) =>
    path(request) === "/auth/sign-in"
      ? gate.promise
      : { code: 200, data: { user: { _id: "fixture-user", isPunched: true } } };
  const first = runBikaAuthAndCheckInLoop(),
    second = runBikaAuthAndCheckInLoop();
  assert.equal(first, second);
  await setImmediate();
  assert.equal(requests.length, 1);
  gate.resolve({ code: 200, data: { token: "fixture-new-token" } });
  await Promise.all([first, second]);
  assert.deepEqual(requests.map(path), ["/auth/sign-in", "/users/profile"]);
});

test("an already checked-in account stays silent across repeated automatic runs", async () => {
  credentials();
  await runBikaAuthAndCheckInLoop();
  await runBikaAuthAndCheckInLoop();
  assert.deepEqual(requests.map(path), ["/auth/sign-in", "/users/profile", "/auth/sign-in", "/users/profile"]);
  assert.deepEqual(checkinNotices, []);
});

test("newly confirmed automatic check-in emits only the account and observed date", async () => {
  credentials();
  let punched = false;
  respond = async (request) => {
    if (path(request) === "/auth/sign-in") return { code: 200, data: { token: "fixture-new-token" } };
    if (path(request) === "/users/punch-in") {
      punched = true;
      return { code: 200, data: { status: "ok" } };
    }
    return { code: 200, data: { user: { _id: "fixture-user", isPunched: punched } } };
  };
  await runBikaAuthAndCheckInLoop();
  await runBikaAuthAndCheckInLoop();
  assert.equal(requests.filter(request => path(request) === "/users/punch-in").length, 1);
  assert.deepEqual(checkinNotices, [{ name: "breeze.checkin.completed", payload: {
    accountId: "fixture-user",
    date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
  } }]);
});

test("a manual caller sharing the automatic punch owns the feedback", async () => {
  credentials();
  const punchStarted = deferred<void>();
  const finishPunch = deferred<void>();
  let punched = false;
  respond = async (request) => {
    if (path(request) === "/auth/sign-in") return { code: 200, data: { token: "fixture-new-token" } };
    if (path(request) === "/users/punch-in") {
      punchStarted.resolve();
      await finishPunch.promise;
      punched = true;
      return { code: 200, data: { status: "ok" } };
    }
    return { code: 200, data: { user: { _id: "fixture-user", isPunched: punched } } };
  };
  const automatic = runBikaAuthAndCheckInLoop();
  await punchStarted.promise;
  const manual = checkInToday();
  await setImmediate();
  finishPunch.resolve();
  await automatic;
  assert.equal((await manual).data.ok, true);
  assert.equal(requests.filter(request => path(request) === "/users/punch-in").length, 1);
  assert.deepEqual(checkinNotices, []);
});

test("logout during backoff cancels the old generation before another request", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  credentials();
  respond = async (request) => {
    throw httpFailure(request, 503);
  };
  const flow = runBikaAuthAndCheckInLoop();
  await setImmediate();
  await clearPluginSession();
  context.mock.timers.tick(1000);
  await flow;
  context.mock.timers.tick(600_000);
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(config.get("auth.authorization"), "");
});

test("a newer manual login cannot be replaced by an older background retry", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  credentials();
  respond = async (request) => {
    throw httpFailure(request, 503);
  };
  const flow = runBikaAuthAndCheckInLoop();
  await setImmediate();
  respond = async () => ({ code: 200, data: { token: "fixture-manual-token" } });
  await loginWithPassword({
    account: "manual@example.invalid",
    password: "fixture-manual-password",
  });
  context.mock.timers.tick(1000);
  await flow;
  assert.equal(requests.length, 2);
  assert.equal(config.get("auth.authorization"), "fixture-manual-token");
  assert.equal(config.get("auth.account"), "manual@example.invalid");
});

test("logout invalidates a delayed successful login before it can write or check in", async () => {
  credentials();
  const gate = deferred<unknown>();
  respond = () => gate.promise;
  const flow = runBikaAuthAndCheckInLoop();
  await setImmediate();
  await clearPluginSession();
  gate.resolve({ code: 200, data: { token: "fixture-new-token" } });
  await flow;
  assert.equal(requests.length, 1);
  assert.equal(config.get("auth.authorization"), "");
  assert.ok(writes.every(({ value }) => value === ""));
});

test("manual account changes while background credentials load stop the old flow before HTTP", async () => {
  credentials();
  const entered = deferred<void>(),
    release = deferred<void>();
  beforeLoad = async (key) => {
    if (key === "auth.account") {
      entered.resolve();
      await release.promise;
    }
  };
  const flow = runBikaAuthAndCheckInLoop();
  await entered.promise;
  await loginWithPassword({
    account: "manual@example.invalid",
    password: "fixture-manual-password",
  });
  release.resolve();
  await flow;
  assert.equal(requests.length, 1);
  assert.equal(config.get("auth.account"), "manual@example.invalid");
});

test("a rejected session write cannot release logout while another login write is pending", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  beforeSave = async (key, value) => {
    if (key === "auth.account" && value !== "") throw new Error("fixture failed account write");
    if (key === "auth.authorization" && value === "fixture-new-token") {
      entered.resolve();
      await release.promise;
    }
  };
  const login = loginWithPassword({
    account: "fixture@example.invalid",
    password: "fixture-password",
  }).catch((error) => error);
  await entered.promise;
  const logout = clearPluginSession();
  await setImmediate();
  release.resolve();
  await Promise.all([login, logout]);
  for (const key of ["auth.account", "auth.password", "auth.authorization"])
    assert.equal(config.get(key), "");
});

test("a failed session write does not poison the next manual login", async () => {
  beforeSave = async (key) => {
    if (key === "auth.account") throw new Error("fixture failed account write");
  };
  await assert.rejects(
    loginWithPassword({ account: "fixture@example.invalid", password: "fixture-password" }),
    /failed account write/,
  );
  beforeSave = async () => {};
  await loginWithPassword({ account: "next@example.invalid", password: "fixture-next-password" });
  assert.equal(config.get("auth.account"), "next@example.invalid");
  assert.equal(config.get("auth.authorization"), "fixture-new-token");
});

test("the automatic budget is three total rounds even when login succeeds but profile reads fail", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  credentials();
  respond = async (request) => {
    if (path(request) === "/auth/sign-in")
      return { code: 200, data: { token: "fixture-new-token" } };
    throw httpFailure(request, 503);
  };
  const flow = runBikaAuthAndCheckInLoop();
  await setImmediate();
  context.mock.timers.tick(1000);
  await setImmediate();
  context.mock.timers.tick(2000);
  await flow;
  assert.equal(requests.filter((request) => path(request) === "/auth/sign-in").length, 3);
  assert.equal(requests.filter((request) => path(request) === "/users/profile").length, 3);
  assert.ok(requests.every((request) => path(request) !== "/users/punch-in"));
  context.mock.timers.tick(600_000);
  await setImmediate();
  assert.equal(requests.length, 6);
});

test("a delayed password update cannot save credentials after logout", async () => {
  credentials();
  const gate = deferred<unknown>();
  respond = () => gate.promise;
  const updating = updatePassword({ value: "fixture-next-password" }).catch((error) => error);
  await setImmediate();
  assert.equal(path(requests[0]!), "/users/password");
  await clearPluginSession();
  gate.resolve({ code: 200 });
  assert.match((await updating).message, /账号已变化/);
  for (const key of ["auth.account", "auth.password", "auth.authorization"])
    assert.equal(config.get(key), "");
});

test("a password change preserves its successful contract and cancels an older background retry", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  credentials();
  config.set("auth.authorization", "fixture-private-token");
  respond = async (request) => {
    throw httpFailure(request, 503);
  };
  const flow = runBikaAuthAndCheckInLoop();
  await setImmediate();
  respond = async () => ({ code: 200 });
  assert.equal((await updatePassword({ value: "fixture-next-password" })).ok, true);
  context.mock.timers.tick(1000);
  await flow;
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.method, "PUT");
  assert.deepEqual(JSON.parse(requests[1]!.data), {
    old_password: "fixture-password",
    new_password: "fixture-next-password",
  });
  assert.equal(config.get("auth.password"), "fixture-next-password");
  assert.equal(config.get("auth.account"), "fixture@example.invalid");
  assert.equal(config.get("auth.authorization"), "fixture-private-token");
});

test("a login canceled while reading request authorization never reaches HTTP and preserves the safe account-change reason", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  beforeLoad = async (key) => {
    if (key === "auth.authorization") {
      entered.resolve();
      await release.promise;
    }
  };
  const login = loginWithPassword({
    account: "fixture@example.invalid",
    password: "fixture-password",
  }).catch((error) => error);
  await entered.promise;
  await clearPluginSession();
  release.resolve();
  assert.match((await login).message, /账号已变化/);
  assert.equal(requests.length, 0);
  assert.equal(config.get("auth.authorization"), "");
});
