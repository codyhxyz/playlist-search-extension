import { YOUTUBE_ORIGIN, hasYouTubePermission, touchesYouTube } from "./onboarding-state.js";

(() => {
  const heading = document.getElementById("heading");
  const permission = document.getElementById("permission");
  const ready = document.getElementById("ready");
  const grantBtn = /** @type {HTMLButtonElement} */ (document.getElementById("grant"));
  const openBtn = /** @type {HTMLButtonElement} */ (document.getElementById("open"));
  const status = document.getElementById("status");
  const version = document.getElementById("version");
  version.textContent = `v${chrome.runtime.getManifest().version}`;

  let generation = 0;
  let state = "checking";
  let requesting = false;

  function setStatus(text, error = false) {
    status.textContent = text;
    status.dataset.state = error ? "err" : "";
  }

  function render(next, message = "") {
    state = next;
    const complete = state === "ready";
    const pending = ["checking", "requesting", "registering"].includes(state);
    document.body.dataset.permission = complete ? "granted" : "ungranted";
    permission.hidden = complete;
    ready.hidden = !complete;
    heading.textContent = complete
      ? "You’re ready to use Playlist Search."
      : state === "error"
        ? "Setup isn’t finished yet."
        : state === "registering"
          ? "Finishing YouTube setup…"
          : "Enable search in YouTube’s Save menu.";
    grantBtn.disabled = pending || requesting;
    grantBtn.textContent = state === "error" ? "Try setup again" : "Grant YouTube access";
    openBtn.disabled = !complete;
    permission.setAttribute("aria-busy", String(pending));
    setStatus(message, state === "error");
  }

  async function register(id) {
    render("registering", "Setting up YouTube access…");
    const response = await chrome.runtime.sendMessage({ type: "permissionGranted" });
    if (id !== generation) return;
    if (response?.ok !== true) {
      throw new Error("Registration failed");
    }
    // A successful worker response alone does not prove access is still allowed.
    const granted = await hasYouTubePermission();
    if (id !== generation) return;
    if (!granted) {
      render("ungranted", "YouTube access was removed. Grant access to continue.");
      return;
    }
    render("ready", "YouTube access allowed. Setup complete.");
  }

  async function checkPermission() {
    const id = ++generation;
    render("checking", "Checking YouTube access…");
    try {
      const granted = await hasYouTubePermission();
      if (id !== generation) return;
      if (!granted) {
        render("ungranted");
        return;
      }
      await register(id);
    } catch {
      if (id !== generation) return;
      render("error", "Couldn’t verify setup. Try setup again. If it still fails, reload the extension in chrome://extensions, then reopen this page.");
    }
  }

  async function onGrantClick() {
    if (requesting || ["checking", "requesting", "registering", "ready"].includes(state)) return;
    const id = ++generation;
    requesting = true;
    render("requesting", "Choose Allow in Chrome’s permission prompt…");
    try {
      // Keep this call in the click gesture: no asynchronous preflight.
      const granted = await chrome.permissions.request({ origins: [YOUTUBE_ORIGIN] });
      if (id !== generation) return;
      requesting = false;
      if (!granted) {
        render("ungranted", "Access wasn’t allowed. Click Grant YouTube access to try again, then choose Allow.");
        grantBtn.focus();
        return;
      }
      await register(id);
      if (id === generation) {
        if (state === "ready") heading.focus();
        else grantBtn.focus();
      }
    } catch {
      if (id !== generation) return;
      requesting = false;
      render("error", "Setup couldn’t finish. Try setup again. If it still fails, reload the extension in chrome://extensions, then reopen this page.");
      grantBtn.focus();
    } finally {
      requesting = false;
      if (id !== generation && state === "ungranted") grantBtn.disabled = false;
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
  openBtn.addEventListener("click", onOpenClick);
  chrome.permissions.onAdded.addListener((p) => {
    // The request path already verifies setup; do not race its own permission event.
    if (touchesYouTube(p) && !requesting && state !== "registering") void checkPermission();
  });
  chrome.permissions.onRemoved.addListener((p) => {
    if (!touchesYouTube(p)) return;
    ++generation;
    render("ungranted", "YouTube access was removed. Grant access to continue.");
  });
  void checkPermission();
})();
