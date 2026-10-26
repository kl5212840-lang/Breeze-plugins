import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginInfo } from "../src/get-info.ts";

test("source website is separate from the plugin project home", () => {
  const info = buildPluginInfo();
  assert.equal(info.websiteUrl, "https://www.mangacopy.com/");
  assert.equal(info.home, "https://github.com/kl5212840-lang/Breeze-plugin-copyComic");
  assert.notEqual(new URL(info.websiteUrl).host, new URL(info.home!).host);
});
