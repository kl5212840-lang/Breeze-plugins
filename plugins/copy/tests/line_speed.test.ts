import test from "node:test";
import assert from "node:assert/strict";
import {
  CopyLineSpeedTest,
  probeCopyRoute,
  type RouteProbe,
  type SpeedContext,
} from "../src/line-speed.ts";

const payload = () => ({
  code: 200,
  results: { total: 1, list: [{ path_word: "public-comic", name: "Public comic" }] },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
test("probe validates a real public payload and includes response-body time without sending credentials", async () => {
  let now = 100;
  const result = await probeCopyRoute("Mainland 3", "https://api.2025copy.com/api/v3", "1", {
    now: () => now,
    fetch: async (input) => {
      const request = input as Request,
        url = new URL(request.url);
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      assert.equal(request.credentials, "omit");
      assert.equal(request.body, null);
      assert.equal(url.pathname, "/api/v3/comics");
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(url.searchParams.get("platform"), "1");
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("cookie"), null);
      const response = json(payload()),
        text = response.text.bind(response);
      response.text = async () => {
        now = 175;
        return text();
      };
      return response;
    },
  });
  assert.deepEqual(result, {
    choice: "Mainland 3",
    host: "api.2025copy.com",
    ok: true,
    ms: 75,
    status: 200,
  });
});
for (const [name, body, status] of [
  ["HTTP 200 with a login response", { code: 401, message: "login" }, 200],
  ["HTTP 200 with an empty object", {}, 200],
  ["HTTP 200 without valid comics", { code: 200, results: { total: 1, list: [{}] } }, 200],
  [
    "HTTP 200 with invalid totals",
    { code: 200, results: { total: 0, list: [{ path_word: "a", name: "A" }] } },
    200,
  ],
  ["non-success HTTP", payload(), 503],
] as const) {
  test(`probe rejects ${name}`, async () => {
    const result = await probeCopyRoute("a", "https://a.example/api/v3", "1", {
      fetch: async () => json(body, status),
    });
    assert.equal(result.ok, false);
    assert.equal(result.ms, null);
  });
}
test("probe rejects HTML, redirects and oversized metadata rather than ranking them as fast", async () => {
  for (const response of [
    new Response("<html>challenge</html>"),
    json(payload()),
    new Response("{}", { headers: { "content-length": "9999999" } }),
  ]) {
    if (response.headers.get("content-type")?.includes("json"))
      Object.defineProperty(response, "url", { value: "https://unlisted.example/api/v3/comics" });
    assert.equal(
      (await probeCopyRoute("a", "https://a.example/api/v3", "1", { fetch: async () => response }))
        .ok,
      false,
    );
  }
});
test("probe has one whole-request deadline, including a stalled body", async () => {
  const result = await probeCopyRoute("a", "https://a.example/api/v3", "1", {
    timeoutMs: 10,
    fetch: async (input) => {
      const request = input as Request;
      const response = json(payload());
      response.text = () =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener("abort", () => reject(Error("cancelled")), {
            once: true,
          }),
        );
      return response;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ms, null);
});

const bases = Object.fromEntries(
  ["a", "b", "c", "d", "hot"].map((choice) => [choice, `https://${choice}.example/api/v3`]),
);
const ok = (choice: string, base: string): RouteProbe => ({
  choice,
  host: new URL(base).hostname,
  ok: true,
  ms: choice === "a" ? 2 : 30,
  status: 200,
});
function fixture(probe?: (choice: string, base: string, platform: string) => Promise<RouteProbe>) {
  let raw: unknown = "",
    current = true;
  const context: SpeedContext = { choice: "b", platform: "1" },
    writes: string[] = [];
  const speed = new CopyLineSpeedTest({
    bases,
    context: async () => ({ ...context }),
    current: () => current,
    store: {
      load: async () => raw,
      save: async (value) => {
        raw = JSON.parse(value);
        writes.push(value);
      },
    },
    now: () => 12345,
    probe: probe ?? (async (choice, base) => ok(choice, base)),
  });
  return {
    speed,
    context,
    writes,
    setRaw: (value: unknown) => {
      raw = value;
    },
    stop: () => {
      current = false;
    },
  };
}
test("singleflight has at most three probes and never selects the fastest measured route", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let active = 0,
    peak = 0,
    calls = 0;
  const { speed, context, writes } = fixture(async (choice, base) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return ok(choice, base);
  });
  const first = speed.measure(),
    second = speed.measure();
  assert.equal(first, second);
  await new Promise((done) => setImmediate(done));
  assert.equal(active, 3);
  release();
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(peak, 3);
  assert.equal(calls, 5);
  assert.equal(context.choice, "b", "the 2ms a route must never replace manual b");
  assert.equal(writes.length, 1);
  const saved = JSON.parse(writes[0]!);
  assert.deepEqual(saved.context, context);
  assert.equal("selected" in saved, false);
  assert.equal("mode" in saved, false);
  assert.equal(saved.results.length, 5);
});
test("every declared line is measured even when a related-service line is not selected", async () => {
  const { speed, context } = fixture();
  assert.equal(context.choice, "b");
  assert.deepEqual(
    (await speed.measure()).results.map((row) => row.choice),
    ["a", "b", "c", "d", "hot"],
  );
});
for (const reason of ["manual", "platform", "runtime", "newer-record"] as const) {
  test(`${reason} changes fence a pending test without overwriting newer state`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const state = fixture(async (choice, base) => {
      await gate;
      return ok(choice, base);
    });
    const pending = state.speed.measure();
    await new Promise((done) => setImmediate(done));
    if (reason === "manual") {
      state.context.choice = "c";
      state.speed.invalidate();
    }
    if (reason === "platform") state.context.platform = "3";
    if (reason === "runtime") state.stop();
    if (reason === "newer-record")
      state.setRaw({
        version: 1,
        revision: "new-install",
        measuredAt: 1,
        context: { ...state.context },
        results: [],
      });
    release();
    const result = await pending;
    assert.equal(result.stale, true);
    assert.equal(state.writes.length, 0);
  });
}
test("stored records show stale context after a later hand selection; all failures keep that selection", async () => {
  const state = fixture();
  await state.speed.measure();
  state.context.choice = "c";
  assert.equal((await state.speed.snapshot())!.stale, true);
  const failed = fixture(async (choice, base) => ({
    choice,
    host: new URL(base).hostname,
    ok: false,
    ms: null,
    status: 403,
  }));
  const result = await failed.speed.measure();
  assert.equal(result.ok, false);
  assert.equal(failed.context.choice, "b");
  assert.equal(
    (await failed.speed.snapshot())!.results.every((row) => !row.ok),
    true,
  );
});
test("future record versions and failed readback never report saved measurement", async () => {
  const state = fixture();
  state.setRaw({ version: 99 });
  await assert.rejects(state.speed.measure(), /版本/);
  assert.equal(state.writes.length, 0);
  const speed = new CopyLineSpeedTest({
    bases,
    context: async () => ({ choice: "b", platform: "1" }),
    probe: async (choice, base) => ok(choice, base),
    store: { load: async () => "", save: async () => {} },
  });
  await assert.rejects(speed.measure(), /未保存/);
});

for (const length of [8, 14]) {
  test(`version-one ${length}-result record remains readable with all fourteen declared routes`, async () => {
    const declared = Object.fromEntries(Array.from({length: 14}, (_, index) =>
      [`line${index}`, `https://line${index}.example/api/v3`]));
    const results = Object.entries(declared).slice(0, length).map(([choice, base]) => ok(choice, base));
    const raw = {version: 1, revision: "legacy-compatible", measuredAt: 12345,
      context: {choice: "line0", platform: "1"}, results};
    const speed = new CopyLineSpeedTest({bases: declared,
      context: async () => ({choice: "line0", platform: "1"}),
      store: {load: async () => JSON.stringify(raw), save: async () => { throw Error("read must not write"); }},
    });
    const snapshot = await speed.snapshot();
    assert.equal(snapshot?.results.length, length);
    assert.deepEqual(snapshot?.results.map(row => row.choice), results.map(row => row.choice));
  });
}
