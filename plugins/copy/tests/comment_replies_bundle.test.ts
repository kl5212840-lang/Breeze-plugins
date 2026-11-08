import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type sourcePlugin from "../src/index.ts";
const plugin = createRequire(import.meta.url)("../dist/breeze-plugin-copy-comic.bundle.cjs").default as typeof sourcePlugin;

test("host reply alias keeps the real parent ID and comments endpoint", async () => {
  const oldFetch = globalThis.fetch, oldBridge = globalThis.bridge;
  const calls: URL[] = [];
  globalThis.bridge = { call: async (fn: string, key: string, value: unknown) => {
    if (fn === "load_plugin_config") return JSON.stringify({ok:true,value:key === "auth.token" ? "" : value});
    if (fn === "cache.get") return value;
    return null;
  }} as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    const request = input as Request, url = new URL(request.url); calls.push(url);
    assert.equal(request.method, "GET");
    let results: unknown;
    if (url.pathname === "/api/v3/comic2/fixture-work") {
      results = {comic:{uuid:"fixture-uuid",name:"Work"},groups:[]};
    } else {
      assert.equal(url.pathname, "/api/v3/comments");
      assert.equal(url.searchParams.get("comic_id"), "fixture-uuid");
      assert.equal(url.searchParams.get("reply_id"), "parent-31");
      assert.equal(url.searchParams.get("offset"), "10");
      results = {list:[{id:"reply-7",user_name:"Reply author",comment:"Reply body",count:0}],total:11};
    }
    return new Response(JSON.stringify({code:200,results}),{headers:{"content-type":"application/json"}});
  };
  try {
    assert.equal(plugin.loadCommentReplies,plugin.getCommentReplies);
    const result = await plugin.loadCommentReplies({comicId:"fixture-work",commentId:"parent-31",page:2,
      extern:{commentId:"wrong-extern",replyId:"wrong-extern"}});
    assert.equal(result.data.commentId,"parent-31");
    assert.equal(result.data.items[0]?.id,"reply-7");
    assert.equal(result.data.items[0]?.content,"Reply body");
    assert.equal(result.data.paging.hasReachedMax,true);
    assert.ok(calls.some(url=>url.pathname === "/api/v3/comments"));
  } finally {globalThis.fetch=oldFetch;globalThis.bridge=oldBridge;}
});
