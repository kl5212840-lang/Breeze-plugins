import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBikaCategoryArtwork } from "../src/bika-category-art";
import { isBikaNativeVideoShortcut } from "../src/bika-navigation";
import { bikaVideoAction } from "../src/bika-video";

const cases = [
  ["https://www.miss001.com/home", "novel.jpg", "ai_story"],
  ["https://game-download.bidobido.xyz/game/64db6f8b9d36612340f2fabb", "star.jpg?v=3", "game"],
  ["https://www.yyai.vip/explore/app/", "night.jpg?v=2", "night_chat"],
] as const;

test("observed 404 category assets use linked official art or explicit story semantics", () => {
  for (const [link, path, icon] of cases) {
    const result = resolveBikaCategoryArtwork(
      { isWeb: true, link },
      {
        url: `https://file.bidobido.xyz/images/static/${path}`,
        path,
      },
    );
    assert.equal(result.icon, icon);
    if (icon === "ai_story") assert.deepEqual(result, { url: "", path: "", icon });
    else {
      assert.ok(result.url.startsWith("https://"));
      assert.ok(!result.url.includes("file.bidobido.xyz"));
      assert.ok(result.path.endsWith(".png"));
    }
  }
});

test("new upstream cover, unrelated category, and non-web category remain untouched", () => {
  for (const [link, path] of cases) {
    const futureCover = {
      url: "https://file.bidobido.xyz/images/static/new.jpg?v=4",
      path: "new.jpg?v=4",
    };
    assert.equal(resolveBikaCategoryArtwork({ isWeb: true, link }, futureCover), futureCover);
    const current = { url: `https://file.bidobido.xyz/images/static/${path}`, path };
    assert.equal(resolveBikaCategoryArtwork({ isWeb: false, link }, current), current);
    assert.equal(
      resolveBikaCategoryArtwork({ isWeb: true, link: `${link}/unrelated` }, current),
      current,
    );
  }
});

test("real public entry tracking parameters do not suppress artwork repair or alter navigation", () => {
  for (const [link, path, icon] of cases) {
    const category = {
      isWeb: true,
      link: `${link}?inviteCode=sample&ranking=1&ref=sample`,
    };
    const result = resolveBikaCategoryArtwork(category, {
      url: `https://file.bidobido.xyz/images/static/${path}`,
      path,
    });
    assert.equal(result.icon, icon);
    assert.equal(category.link, `${link}?inviteCode=sample&ranking=1&ref=sample`);
    for (const unsafe of [
      `https://other.test${new URL(link).pathname}`,
      link.replace("https://", "http://"),
      link.replace("https://", "https://name:password@"),
    ]) {
      const cover = { url: `https://file.bidobido.xyz/images/static/${path}`, path };
      assert.equal(resolveBikaCategoryArtwork({ isWeb: true, link: unsafe }, cover), cover);
    }
  }
});

test("missing art only gains semantics for known public web destinations", () => {
  for (const [link, , icon] of cases) {
    assert.equal(
      resolveBikaCategoryArtwork({ isWeb: true, link }, { url: "", path: "" }).icon,
      icon,
    );
  }
  const empty = { url: "", path: "" };
  assert.equal(
    resolveBikaCategoryArtwork({ isWeb: true, link: "https://example.com" }, empty),
    empty,
  );
});

test("native-video host opt-in hides only supported Bika actions and preserves legacy hosts", () => {
  for (const home of ["https://adult-movie.bidobido.xyz/", "https://adult-animate.bidobido.xyz/"]) {
    const action = bikaVideoAction(home);
    assert.equal(isBikaNativeVideoShortcut(action, true), true);
    for (const flag of [undefined, false, "true", 1])
      assert.equal(isBikaNativeVideoShortcut(action, flag), false);
    assert.equal(isBikaNativeVideoShortcut({ ...action, type: "openWeb" }, true), false);
    assert.equal(
      isBikaNativeVideoShortcut(
        { ...action, payload: { ...action.payload, url: `${home}?token=other` } },
        true,
      ),
      false,
    );
    assert.equal(
      isBikaNativeVideoShortcut(
        { ...action, payload: { ...action.payload, source: "other" } },
        true,
      ),
      false,
    );
    assert.equal(
      isBikaNativeVideoShortcut(
        { ...action, payload: { ...action.payload, catalogFnPath: "other" } },
        true,
      ),
      false,
    );
  }
  assert.equal(
    isBikaNativeVideoShortcut({ title: "小電影", type: "openWeb", payload: {} }, true),
    false,
  );
});
