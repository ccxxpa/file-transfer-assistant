// Track the visible area, including keyboards that do not resize the layout
// viewport (iOS Safari).
(() => {
  const root = document.documentElement;
  const platform = window.navigator;
  const isIOS =
    /iPhone|iPad|iPod/.test(platform.userAgent) ||
    (platform.platform === "MacIntel" && platform.maxTouchPoints > 1);
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  // Safari/Chrome on iOS allow manual pinch zoom independently of this limit,
  // but WebKit respects it when automatically zooming to a focused input.
  // Keep this workaround out of Android and embedded web views, which may
  // enforce maximum-scale on manual zoom too.
  // https://webkit.org/blog/7367/new-interaction-behaviors-in-ios-10/
  if (isIOS && /Safari\//.test(platform.userAgent) && viewportMeta) {
    viewportMeta.content = `${viewportMeta.content},maximum-scale=1,user-scalable=yes`;
  }
  let frame = 0;
  let layoutWidth = window.innerWidth;
  let restingHeight = window.innerHeight;

  function update() {
    frame = 0;
    const viewport = window.visualViewport;
    const scale = viewport?.scale || 1;
    const zoomed = Math.abs(scale - 1) > 0.05;
    // A zoom alone must not shrink the layout, but keyboard changes still
    // need to be handled while zoomed. Convert back to unzoomed dimensions.
    const height = viewport ? viewport.height * scale : window.innerHeight;
    const editable = document.activeElement?.matches(
      'input, textarea, [contenteditable="true"]',
    );
    if (window.innerWidth !== layoutWidth) {
      layoutWidth = window.innerWidth;
      restingHeight = height;
    } else if (!editable) {
      restingHeight = height;
    }
    root.style.setProperty("--app-height", `${height}px`);
    // Follow keyboard panning at normal scale; preserve ordinary pinch/pan
    // instead of making the entire page chase the finger while magnified.
    if (!zoomed)
      root.style.setProperty("--viewport-top", `${viewport?.offsetTop || 0}px`);
    root.classList.toggle(
      "keyboard-open",
      Boolean(
        editable && Math.max(window.innerHeight, restingHeight) - height > 100,
      ),
    );
    window.dispatchEvent(new Event("assistant:viewport"));
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  update();
})();
