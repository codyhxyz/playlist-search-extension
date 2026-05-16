"use strict";

(() => {
  const { YOUTUBE_ORIGIN, hasYouTubePermission } = globalThis.YTPF_onboarding;

  const stepGrant = document.getElementById("step-grant");
  const stepOpen = document.getElementById("step-open");
  const grantDesc = document.getElementById("grant-desc");
  const grantBtn = document.getElementById("grant");
  const openBtn = document.getElementById("open");
  const status = document.getElementById("status");
  const version = document.getElementById("version");

  const manifest = chrome.runtime.getManifest();
  if (manifest?.version) {
    version.textContent = `v${manifest.version}`;
  }

  function setStatus(text, state) {
    status.textContent = text;
    if (state) {
      status.dataset.state = state;
    } else {
      delete status.dataset.state;
    }
  }

  function render(granted) {
    document.body.dataset.permission = granted ? "granted" : "ungranted";
    if (granted) {
      stepGrant.dataset.state = "complete";
      stepOpen.dataset.state = "active";
      grantDesc.textContent =
        "You're all set — the extension is active on youtube.com. Nothing leaves your device.";
      grantBtn.textContent = "Access granted";
      grantBtn.disabled = true;
      openBtn.disabled = false;
      setStatus("", null);
    } else {
      stepGrant.dataset.state = "active";
      stepOpen.dataset.state = "pending";
      grantBtn.textContent = "Grant access to YouTube";
      grantBtn.disabled = false;
      openBtn.disabled = true;
    }
  }

  async function onGrantClick() {
    try {
      const granted = await chrome.permissions.request({
        origins: [YOUTUBE_ORIGIN],
      });
      if (!granted) {
        setStatus("Access not granted. Click the button to try again.", "err");
        return;
      }
      chrome.runtime.sendMessage({ type: "permissionGranted" }).catch(() => {});
      render(true);
    } catch (err) {
      setStatus(`Something went wrong: ${err?.message || err}`, "err");
    }
  }

  function onOpenClick() {
    chrome.tabs.create({ url: "https://www.youtube.com/" });
  }

  grantBtn.addEventListener("click", onGrantClick);
  openBtn.addEventListener("click", onOpenClick);

  chrome.permissions.onAdded.addListener((p) => {
    if (p?.origins?.includes(YOUTUBE_ORIGIN)) render(true);
  });
  chrome.permissions.onRemoved.addListener((p) => {
    if (p?.origins?.includes(YOUTUBE_ORIGIN)) render(false);
  });

  hasYouTubePermission().then(render);
})();
