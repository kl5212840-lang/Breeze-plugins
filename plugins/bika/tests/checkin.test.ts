import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import client from "../src/client";
import { beginBikaAuthChange, checkInToday, getCheckinStatus } from "../src/bika-checkin";
import {
  getUserInfoBundle,
  loginWithPassword,
  runBikaAuthAndCheckInLoop,
} from "../src/bika-settings";
import { bikaRequest } from "../src/bika-request";
import { BIKA_PLUGIN_ID, buildManifestInfo } from "../src/info";

// Real request/signature adapter, but all config/HTTP/credentials are synthetic.
// No socket is opened and no user's plugin store is loaded or cleared.
const config = new Map<string, unknown>();
const cache = new Map<string, unknown>();
const requests: InternalAxiosRequestConfig[] = [];
const writes: string[] = [];
let toasts = 0;
let respond: (request: InternalAxiosRequestConfig) => Promise<unknown>;
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto,
  uuidv4: nodeCrypto.randomUUID,
  bridge: {
    async call(name: string, ...args: unknown[]) {
      const key = String(args[0]);
      switch (name) {
        case "load_plugin_config":
          return {
            ok: true,
            value: config.has(key) ? config.get(key) : JSON.parse(String(args[1])),
          };
        case "save_plugin_config":
          writes.push(key);
          config.set(key, JSON.parse(String(args[1])));
          return { ok: true };
        case "cache.get":
          return cache.has(key) ? cache.get(key) : args[1];
        case "cache.set":
          cache.set(key, args[1]);
          return;
        case "cache.delete":
          cache.delete(key);
          return;
        default:
          if (name.toLowerCase().includes("toast")) {
            toasts++;
            return;
          }
          throw new Error(`Unexpected offline bridge operation ${name}`);
      }
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
  toasts = 0;
  config.set("auth.authorization", "fixture-token");
  respond = async () => profile(false);
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

function profile(isPunched: unknown, extra: Record<string, unknown> = {}) {
  return {
    code: 200,
    data: { user: { _id: "fixture-user", name: "Fixture", isPunched, ...extra } },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const path = (request: InternalAxiosRequestConfig) => new URL(request.url!).pathname;

test("metadata exposes manual and read-only functions without claiming a server reset timezone", () => {
  const experience = buildManifestInfo().breezeExperience;
  assert.equal(experience.profileCheckinFunction, "checkInToday");
  assert.equal(experience.profileCheckinStatusFunction, "getCheckinStatus");
  assert.equal(experience.profileCheckinDateBasis, "observedUtc8");
  assert.equal(experience.profileCheckinStatusSource, "serverProfile");
  assert.equal(experience.bikaExperience.version, 1);
  assert.equal(experience.bikaExperience.appearanceKey, "ui.experienceStyle");
  assert.equal("gameListFunction" in experience.bikaExperience, false);
  assert.deepEqual(experience.legacySources, ["0a0e5858-a467-4702-994a-79e608a4589d"]);
});

test("profile slogan preserves text and treats missing or malformed values as empty", async () => {
  for (const [raw, expected] of [
    ["  简介保留\n第二行  ", "简介保留\n第二行"],
    [null, ""],
    [undefined, ""],
    [" \n ", ""],
    [{ text: "not a slogan" }, ""],
  ] as const) {
    respond = async () => profile(false, { slogan: raw });
    const bundle = await getUserInfoBundle();
    assert.equal(bundle.data.extern?.slogan, expected);
    assert.equal(bundle.data.lines[0], expected ? `Fixture (${expected})` : "Fixture");
  }
});

test("fresh official already-punched profile returns account proof and never posts or writes a receipt", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 4) });
  respond = async () => profile(true);
  const result = await checkInToday({ accountId: "fixture-user" });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.accountId, "fixture-user");
  assert.equal(result.data.checkedInDate, "2026-11-02");
  assert.equal(result.data.verification.source, "serverProfile");
  assert.equal(result.data.verification.dateBasis, "observedUtc8");
  assert.equal(result.data.verification.serverDate, null);
  assert.equal(result.data.checkinProof?.verifiedThisRequest, true);
  assert.deepEqual(
    requests.map((request) => [request.method, path(request)]),
    [["GET", "/users/profile"]],
  );
  assert.equal(requests[0]!.headers.get("authorization"), "fixture-token");
  assert.deepEqual(writes, []);
});

test("manual punch is one POST followed by exact same-account profile confirmation", async () => {
  let punched = false;
  respond = async (request) => {
    if (request.method === "POST") {
      punched = true;
      return {
        code: 200,
        data: { res: { status: "ok", punchInLastDay: "fixture-untrusted-date" } },
      };
    }
    return profile(punched);
  };
  const result = await checkInToday();
  assert.equal(result.data.ok, true);
  assert.deepEqual(
    requests.map((request) => [request.method, path(request)]),
    [
      ["GET", "/users/profile"],
      ["POST", "/users/punch-in"],
      ["GET", "/users/profile"],
    ],
  );
  assert.equal(requests[1]!.data, "{}");
  assert.ok(requests.every((request) => request.headers.get("authorization") === "fixture-token"));
  assert.deepEqual(writes, []);
});

for (const status of ["ok", "arbitrary", "fail", true, null]) {
  test(`HTTP 200 and punch status ${JSON.stringify(status)} never substitute for a false profile`, async () => {
    respond = async (request) =>
      request.method === "POST" ? { code: 200, data: { res: { status } } } : profile(false);
    const result = await checkInToday();
    assert.equal(result.data.ok, false);
    assert.equal(result.data.checkedIn, false);
    assert.equal(result.data.checkedInDate, null);
    assert.equal(result.data.checkinProof, null);
    assert.equal(result.data.verification.status, "notSigned");
  });
}

for (const signed of [undefined, null, 1, "true"]) {
  test(`unknown profile isPunched ${JSON.stringify(signed)} is not false and never posts`, async () => {
    respond = async () => profile(signed);
    const result = await checkInToday();
    assert.equal(result.data.ok, false);
    assert.equal(result.data.checkedIn, null);
    assert.equal(result.data.isPunched, null);
    assert.equal(requests.length, 1);
    const bundle = await getUserInfoBundle();
    assert.equal(bundle.data.extern?.level, null);
    assert.equal(bundle.data.extern?.exp, null);
    assert.ok(
      bundle.data.lines.every(
        (line) => !line.includes("未签到") && !line.includes("Lv.0") && !line.includes("经验值: 0"),
      ),
    );
  });
}

test("read-only status always reaches profile, does not log in and ignores no cached receipt", async () => {
  config.set("auth.account", "fixture-account");
  config.set("auth.password", "fixture-password");
  config.set("auth.checkin", { accountId: "fixture-user", checkedIn: true });
  respond = async () => profile(false);
  assert.equal((await getCheckinStatus()).data.checkedIn, false);
  respond = async () => profile(true);
  assert.equal((await getCheckinStatus()).data.checkedIn, true);
  assert.deepEqual(requests.map(path), ["/users/profile", "/users/profile"]);
  assert.ok(requests.every((request) => request.method === "GET"));
  assert.deepEqual(writes, []);
});

test("unavailable profile never uses cached data or an empty authorization to claim success", async () => {
  respond = async () => {
    throw new Error("fixture network failure");
  };
  await assert.rejects(getCheckinStatus());
  await assert.rejects(getUserInfoBundle());
  assert.ok(requests.every((request) => request.method === "GET"));
  requests.length = 0;
  config.set("auth.authorization", "");
  config.set("auth.account", "fixture-account");
  config.set("auth.password", "fixture-password");
  await assert.rejects(getCheckinStatus(), /请先登录/);
  await assert.rejects(checkInToday(), /请先登录/);
  assert.equal(requests.length, 0);
});

test("a lost POST response is only successful when a following profile explicitly confirms it", async () => {
  let punched = false;
  respond = async (request) => {
    if (request.method === "POST") {
      punched = true;
      throw new Error("fixture lost response");
    }
    return profile(punched);
  };
  assert.equal((await checkInToday()).data.ok, true);
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("failed verification after POST never produces a successful result", async () => {
  let posted = false;
  respond = async (request) => {
    if (request.method === "POST") {
      posted = true;
      return { code: 200, data: { res: { status: "ok" } } };
    }
    if (posted) throw new Error("fixture verification unavailable");
    return profile(false);
  };
  await assert.rejects(checkInToday());
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("simultaneous user requests share a single check-and-submit operation", async () => {
  const gate = deferred<unknown>();
  let reads = 0;
  respond = async (request) =>
    request.method === "POST"
      ? { code: 200, data: { res: { status: "ok" } } }
      : ++reads === 1
        ? await gate.promise
        : profile(true);
  const first = checkInToday();
  const second = checkInToday();
  await setImmediate();
  assert.equal(requests.length, 1);
  gate.resolve(profile(false));
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.data.ok));
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("account identity changes invalidate old profile replies before any punch", async () => {
  const gate = deferred<unknown>();
  respond = () => gate.promise;
  const reading = checkInToday().catch((error) => error);
  await setImmediate();
  beginBikaAuthChange();
  gate.resolve(profile(false));
  assert.match((await reading).message, /账号已变化/);
  assert.equal(requests.length, 1);
});

test("a changed authorization after POST blocks all follow-up reads and old results", async () => {
  respond = async (request) => {
    if (request.method === "POST") {
      config.set("auth.authorization", "fixture-next-token");
      return { code: 200 };
    }
    return profile(false);
  };
  await assert.rejects(checkInToday(), /账号已变化/);
  assert.equal(requests.length, 2);
});

test("renewed authorization for the same account cannot duplicate an in-flight punch", async () => {
  const gate = deferred<unknown>();
  respond = async (request) => (request.method === "POST" ? await gate.promise : profile(false));
  const first = checkInToday().catch((error) => error);
  await setImmediate();
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  beginBikaAuthChange();
  config.set("auth.authorization", "fixture-renewed-token");
  const next = await checkInToday();
  assert.equal(next.data.ok, false);
  assert.match(next.data.message, /正在处理/);
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  gate.resolve({ code: 200 });
  assert.match((await first).message, /账号已变化/);
});

test("legacy null authorization sentinels never open an authenticated request", async () => {
  for (const authorization of [null, undefined, "null", "undefined", 42]) {
    config.set("auth.authorization", authorization);
    await assert.rejects(getCheckinStatus(), /请先登录/);
  }
  assert.equal(requests.length, 0);
});

test("missing authorization uses the host unauthorized contract for profile and check-in reads", async () => {
  config.delete("auth.authorization");
  config.set("auth.account", "fixture-email@example.invalid");
  config.set("auth.password", "fixture-password");
  for (const operation of [getUserInfoBundle, getCheckinStatus, checkInToday]) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.deepEqual(JSON.parse(error.message), {
        type: "unauthorized",
        source: BIKA_PLUGIN_ID,
        message: "请先登录哔咔账号",
      });
      assert.doesNotMatch(error.message, /fixture-password|fixture-email|fixture-token/);
      return true;
    });
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(writes, []);
});

test("the post-read identity must equal the pre-read identity even with unchanged authorization", async () => {
  let posted = false;
  respond = async (request) => {
    if (request.method === "POST") {
      posted = true;
      return { code: 200 };
    }
    return profile(posted, posted ? { _id: "different-fixture" } : {});
  };
  await assert.rejects(checkInToday(), /账号已变化/);
});

test("a caller's mismatched account never submits and a stale pinned authorization never reaches HTTP", async () => {
  await assert.rejects(checkInToday({ accountId: "another-fixture" }), /账号已变化/);
  assert.equal(requests.length, 1);
  requests.length = 0;
  await assert.rejects(
    bikaRequest({
      url: "https://fixture.invalid/users/punch-in",
      method: "POST",
      authorization: "stale-fixture",
    }),
  );
  assert.equal(requests.length, 0);
});

test("a response crossing the UTC+8 observation date cannot establish a new-day check-in", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 15, 59, 59) });
  respond = async () => {
    context.mock.timers.tick(1000);
    return profile(true);
  };
  await assert.rejects(checkInToday(), /日期已变化/);
  assert.equal(requests.length, 1);
});

test("an invalid profile envelope or missing ID never establishes a check-in", async () => {
  for (const data of [
    { code: 500, data: profile(true).data },
    { code: 200, data: { user: { isPunched: true } } },
  ]) {
    respond = async () => data;
    await assert.rejects(getCheckinStatus(), /账号资料/);
  }
});

test("the existing automatic path uses verified profile state rather than POST status", async () => {
  config.set("auth.account", "fixture-account");
  config.set("auth.password", "fixture-password");
  respond = async (request) =>
    path(request) === "/auth/sign-in"
      ? { code: 200, data: { token: "fixture-renewed-token" } }
      : request.method === "POST"
        ? { code: 200, data: { res: { status: "ok" } } }
        : profile(false);
  await runBikaAuthAndCheckInLoop();
  assert.equal(toasts, 0);
  assert.deepEqual(requests.map(path), [
    "/auth/sign-in",
    "/users/profile",
    "/users/punch-in",
    "/users/profile",
  ]);
});

test("automatic login preserves the already-signed behavior without another punch", async () => {
  config.set("auth.account", "fixture-account");
  config.set("auth.password", "fixture-password");
  respond = async (request) =>
    path(request) === "/auth/sign-in"
      ? { code: 200, data: { token: "fixture-renewed-token" } }
      : profile(true);
  await runBikaAuthAndCheckInLoop();
  assert.deepEqual(requests.map(path), ["/auth/sign-in", "/users/profile"]);
  assert.equal(requests.filter((request) => path(request) === "/users/punch-in").length, 0);
});

test("login logical refusal preserves an explicit official reason without writing credentials", async () => {
  respond = async () => ({ code: 400, message: "email or password not match" });
  await assert.rejects(
    loginWithPassword({ account: "fixture-email@example.invalid", password: "fixture-password" }),
    /账号或密码不匹配/,
  );
  assert.deepEqual(writes, []);
  assert.equal(config.get("auth.authorization"), "fixture-token");
});

test("login HTTP401 preserves a real refusal instead of claiming a previous login expired", async () => {
  respond = async (request) => {
    throw new AxiosError("fixture refusal", "ERR_BAD_REQUEST", request, undefined, {
      data: { code: 401, error: "1014", message: "email or password not match" },
      status: 401,
      statusText: "fixture",
      headers: {},
      config: request,
    });
  };
  await assert.rejects(
    loginWithPassword({ account: "fixture-email@example.invalid", password: "fixture-password" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /账号或密码不匹配/);
      assert.doesNotMatch(
        error.message,
        /过期|NEED_LOGIN|fixture-password|fixture-token|fixture-email/,
      );
      return true;
    },
  );
  assert.deepEqual(writes, []);
});

test("an unknown safe official login refusal remains specific, while echoed input is removed", async () => {
  respond = async () => ({ code: 400, message: "Account temporarily unavailable" });
  await assert.rejects(
    loginWithPassword({ account: "fixture-email@example.invalid", password: "fixture-password" }),
    /Account temporarily unavailable/,
  );
  respond = async () => ({
    code: 400,
    message: "Rejected fixture-email@example.invalid fixture-password",
  });
  await assert.rejects(
    loginWithPassword({ account: "fixture-email@example.invalid", password: "fixture-password" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fixture-password|fixture-email/);
      assert.match(error.message, /已隐藏/);
      return true;
    },
  );
  assert.deepEqual(writes, []);
});

test("HTTP refusal cannot expose authorization, password body or a private URL", async () => {
  respond = async (request) => {
    throw new AxiosError("fixture refusal", "ERR_BAD_REQUEST", request, undefined, {
      data: {
        code: 400,
        message: "Rejected fixture-token fixture-password fixture-email@example.invalid",
      },
      status: 400,
      statusText: "fixture",
      headers: {},
      config: request,
    });
  };
  await assert.rejects(
    loginWithPassword({ account: "fixture-email@example.invalid", password: "fixture-password" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(
        error.message,
        /fixture-token|fixture-password|fixture-email|authorization|headers/i,
      );
      return true;
    },
  );
  respond = async () => ({ code: 400, message: "https://private.invalid/?token=short" });
  await assert.rejects(
    loginWithPassword({ account: "fixture-email@example.invalid", password: "fixture-password" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /private.invalid|short|https:/);
      return true;
    },
  );
});
