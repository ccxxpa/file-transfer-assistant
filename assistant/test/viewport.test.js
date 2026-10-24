import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("../public/viewport.js", import.meta.url),
  "utf8",
);
function fixture(navigator = {
  userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Safari/537.36",
  platform: "Linux aarch64",
  maxTouchPoints: 5,
}) {
  const events = new Map();
  const styles = new Map();
  const classes = new Set();
  let frame,
    focused = false;
  const listen = (type, callback) => events.set(type, callback);
  const viewport = {
    height: 844,
    offsetTop: 0,
    scale: 1,
    addEventListener: listen,
  };
  const window = {
    navigator,
    innerWidth: 390,
    innerHeight: 844,
    visualViewport: viewport,
    addEventListener: listen,
    dispatchEvent() {},
  };
  const meta = {
    content: "width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content",
  };
  const document = {
    querySelector: () => meta,
    activeElement: { matches: () => focused },
    addEventListener: listen,
    documentElement: {
      style: { setProperty: (key, value) => styles.set(key, value) },
      classList: {
        toggle: (key, value) =>
          value ? classes.add(key) : classes.delete(key),
      },
    },
  };
  vm.runInNewContext(source, {
    window,
    document,
    Event,
    requestAnimationFrame(callback) {
      frame = callback;
      return 1;
    },
  });
  return {
    window,
    viewport,
    styles,
    classes,
    meta,
    focus() {
      focused = true;
    },
    blur() {
      focused = false;
    },
    update() {
      events.get("resize")();
      const callback = frame;
      frame = null;
      callback();
    },
  };
}

test("iOS-style overlay keyboard reduces visible shell and tracks viewport panning", () => {
  const f = fixture();
  f.focus();
  // Layout viewport remains 844px high, but only 480px is visible above keyboard.
  f.viewport.height = 480;
  f.viewport.offsetTop = 72;
  f.update();
  assert.equal(f.styles.get("--app-height"), "480px");
  assert.equal(f.styles.get("--viewport-top"), "72px");
  assert.equal(f.classes.has("keyboard-open"), true);
  f.blur();
  f.viewport.height = 844;
  f.viewport.offsetTop = 0;
  f.update();
  assert.equal(f.styles.get("--app-height"), "844px");
  assert.equal(f.styles.get("--viewport-top"), "0px");
  assert.equal(f.classes.has("keyboard-open"), false);
});

test("content-resizing keyboards and phone rotation update the visible shell", () => {
  const f = fixture();
  f.focus();
  f.window.innerHeight = 450;
  f.viewport.height = 450;
  f.update();
  assert.equal(f.styles.get("--app-height"), "450px");
  assert.equal(f.classes.has("keyboard-open"), true);
  f.blur();
  f.window.innerWidth = 932;
  f.window.innerHeight = 430;
  f.viewport.height = 430;
  f.update();
  assert.equal(f.styles.get("--app-height"), "430px");
  assert.equal(f.classes.has("keyboard-open"), false);
});

test("pinch zoom does not collapse the chat layout into the magnified viewport", () => {
  const f = fixture();
  f.viewport.scale = 2;
  f.viewport.height = 422;
  f.update();
  assert.equal(f.styles.get("--app-height"), "844px");
  assert.equal(f.classes.has("keyboard-open"), false);
});

test("keyboard changes still update the shell while the page is magnified", () => {
  const f = fixture();
  f.focus();
  f.viewport.scale = 2;
  f.viewport.height = 240;
  f.viewport.offsetTop = 100;
  f.update();
  assert.equal(f.styles.get("--app-height"), "480px");
  assert.equal(f.styles.get("--viewport-top"), "0px");
  assert.equal(f.classes.has("keyboard-open"), true);
  f.blur();
  f.viewport.height = 422;
  f.update();
  assert.equal(f.styles.get("--app-height"), "844px");
  assert.equal(f.classes.has("keyboard-open"), false);
  f.viewport.scale = 1;
  f.viewport.height = 844;
  f.viewport.offsetTop = 0;
  f.update();
  assert.equal(f.styles.get("--viewport-top"), "0px");
});

test("iPhone Safari and Chrome get the automatic focus-zoom guard", () => {
  for (const browser of ["Version/26.0", "CriOS/140.0"]) {
    const f = fixture({
      userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 ${browser} Mobile/15E148 Safari/604.1`,
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    assert.match(f.meta.content, /maximum-scale=1,user-scalable=yes/);
    assert.match(f.meta.content, /viewport-fit=cover/);
  }
});

test("iPad desktop browsing gets the guard without changing Android, Mac, or embedded views", () => {
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15";
  const ipad = fixture({ userAgent: safari, platform: "MacIntel", maxTouchPoints: 5 });
  assert.match(ipad.meta.content, /maximum-scale=1/);
  const mac = fixture({ userAgent: safari, platform: "MacIntel", maxTouchPoints: 0 });
  const embedded = fixture({ userAgent: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148", platform: "iPhone", maxTouchPoints: 5 });
  for (const f of [fixture(), mac, embedded]) {
    assert.doesNotMatch(f.meta.content, /maximum-scale|user-scalable/);
  }
});
