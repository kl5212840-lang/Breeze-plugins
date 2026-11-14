import test from "node:test";
import assert from "node:assert/strict";
import { buildPluginInfo } from "../src/get-info.ts";

test("source website is separate from the plugin project home", () => {
  const info = buildPluginInfo();
  assert.equal(info.websiteUrl, "https://www.mangacopy.com/");
  assert.equal(info.home, "https://github.com/kl5212840-lang/Breeze-plugin-copyComic");
  assert.notEqual(new URL(info.websiteUrl).host, new URL(info.home!).host);
});


test("personal tab replaces standalone cloud favorites and declares the real feed", () => {
  const info = buildPluginInfo();
  assert.equal(info.breezeExperience.profileTab, true);
  assert.equal(info.breezeExperience.profileKind, "generic");
  assert.equal(info.breezeExperience.profileCloudFavoriteFunction, "getCloudFavoriteData");
  assert.deepEqual(info.function?.map(item => item.id), ["recommend", "newest", "discover", "rank"]);
});

test("declares the versioned comic follow capability", () => {
  assert.equal(buildPluginInfo().breezeExperience.comicFollow, 1);
});

test("declares the versioned Copy topic search capability", () => {
  assert.equal(buildPluginInfo().breezeExperience.copyTopicSearch, 1);
});
