import { YOUTUBE_ORIGIN, hasYouTubePermission, touchesYouTube } from "./onboarding-state.js";

(() => {
  const heading = document.getElementById("heading");
  const permission = document.getElementById("permission");
  const grantBtn = /** @type {HTMLButtonElement} */ (document.getElementById("grant"));
  const openBtn = /** @type {HTMLButtonElement} */ (document.getElementById("open"));
  const retryBtn = /** @type {HTMLButtonElement} */ (document.getElementById("retry"));
  const status = document.getElementById("status");
  const version = document.getElementById("version");
  version.textContent = `v${chrome.runtime.getManifest().version}`;

  const demo = /** @type {HTMLVideoElement} */ (document.getElementById("demo-video"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function syncDemoMotion() {
    demo.muted = true;
    demo.autoplay = !reducedMotion.matches;
    if (reducedMotion.matches) demo.pause();
    // Native controls remain usable if the browser blocks automatic playback.
    else void demo.play().catch(() => {});
  }
  reducedMotion.addEventListener("change", syncDemoMotion);
  syncDemoMotion();

  let generation = 0;
  let state = "checking";
  let requesting = false;
  let restricted = false;

  const siteAccessHelp = "In Chrome’s Extensions → YouTube Playlist Search → Site access, allow access to www.youtube.com.";

  function setStatus(text, error = false) {
    status.textContent = text;
    status.dataset.state = error ? "err" : "";
  }

  function render(next, message = "") {
    state = next;
    const pending = ["checking", "requesting", "registering"].includes(state);
    document.body.dataset.permission = restricted ? "restricted" : state === "ready" ? "granted" : "checking";
    permission.hidden = !restricted;
    grantBtn.disabled = pending || requesting;
    openBtn.disabled = state !== "ready";
    retryBtn.hidden = state !== "error" || restricted;
    permission.setAttribute("aria-busy", String(pending));
    setStatus(message || (pending ? "Getting Playlist Search ready…" : ""), state === "error");
  }

  async function register(id) {
    render("registering");
    const response = await chrome.runtime.sendMessage({ type: "permissionGranted" });
    if (id !== generation) return;
    if (response?.ok !== true) throw new Error("Registration failed");
    // A successful worker response alone does not prove access is still allowed.
    const granted = await hasYouTubePermission();
    if (id !== generation) return;
    restricted = !granted;
    if (!granted) {
      render("restricted", `YouTube access was removed. ${siteAccessHelp}`);
      return;
    }
    render("ready");
  }

  async function verifyAndRegister(id) {
    const granted = await hasYouTubePermission();
    if (id !== generation) return;
    restricted = !granted;
    if (!granted) {
      render("restricted", siteAccessHelp);
      return;
    }
    await register(id);
  }

  async function checkPermission() {
    const id = ++generation;
    render("checking");
    try {
      await verifyAndRegister(id);
    } catch {
      if (id !== generation) return;
      render("error", "Couldn’t get Playlist Search ready. Try again. If it still fails, reload the extension in chrome://extensions, then reopen this page.");
    }
  }

  async function onGrantClick() {
    if (!restricted || requesting || ["checking", "requesting", "registering"].includes(state)) return;
    const id = ++generation;
    requesting = true;
    render("requesting", "If Chrome asks, choose Allow to restore YouTube access.");
    try {
      // Keep this call in the click gesture: no asynchronous preflight.
      const granted = await chrome.permissions.request({ origins: [YOUTUBE_ORIGIN] });
      if (id !== generation) return;
      requesting = false;
      if (!granted) {
        render("restricted", `YouTube access wasn’t restored. ${siteAccessHelp}`);
        grantBtn.focus();
        return;
      }
      await verifyAndRegister(id);
      if (id === generation) {
        if (state === "ready") heading.focus();
        else if (restricted) grantBtn.focus();
      }
    } catch {
      if (id !== generation) return;
      requesting = false;
      render("error", restricted
        ? `YouTube access couldn’t be restored. ${siteAccessHelp}`
        : "Couldn’t get Playlist Search ready. Try again. If it still fails, reload the extension in chrome://extensions, then reopen this page.");
      if (restricted) grantBtn.focus();
      else retryBtn.focus();
    } finally {
      requesting = false;
      if (id !== generation && restricted) grantBtn.disabled = false;
    }
  }

  async function onOpenClick() {
    if (state !== "ready" || openBtn.disabled) return;
    const id = generation;
    openBtn.disabled = true;
    try {
      await chrome.tabs.create({ url: "https://www.youtube.com/" });
      if (id === generation) setStatus("YouTube opened in a fresh tab.");
    } catch {
      if (id === generation) setStatus("Couldn’t open YouTube. Try Open YouTube again, or open a fresh YouTube tab yourself.", true);
    } finally {
      if (id === generation && state === "ready") openBtn.disabled = false;
    }
  }

  grantBtn.addEventListener("click", onGrantClick);
  retryBtn.addEventListener("click", () => {
    if (state === "error" && !restricted) return checkPermission();
  });
  openBtn.addEventListener("click", onOpenClick);
  chrome.permissions.onAdded.addListener((p) => {
    // The request path already verifies setup; do not race its own permission event.
    if (touchesYouTube(p) && !requesting && state !== "registering") void checkPermission();
  });
  chrome.permissions.onRemoved.addListener((p) => {
    if (!touchesYouTube(p)) return;
    ++generation;
    restricted = true;
    render("restricted", `YouTube access was removed. ${siteAccessHelp}`);
  });
  void checkPermission();
})();
