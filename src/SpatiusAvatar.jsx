import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  AvatarSDK,
  AvatarManager,
  AvatarView,
  Environment,
  DrivingServiceMode,
  ConnectionState,
  ConversationState
} from "@spatialwalk/avatarkit";

// ---- Endpoint redirect (ported verbatim from the working vanilla main.js) ----
// The account's avatars/tokens live on the spatius.ai cluster, but the SDK's
// dynamic config (config.spatialwalk.top) only lists the old spatialwalk.cloud
// cluster. Intercept the config fetch and rewrite any leftover motion-server
// socket so every host the SDK derives points at spatius.ai.
let spatiusRedirectInstalled = false;
function installSpatiusEndpointRedirect(endpoint) {
  if (spatiusRedirectInstalled) return;
  spatiusRedirectInstalled = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("config.spatialwalk.top/sdk")) {
      const body = JSON.stringify({ endpoints: { cn: endpoint, test: endpoint, intl: endpoint } });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    }
    return originalFetch(input, init);
  };

  const OriginalWebSocket = window.WebSocket;
  const PatchedWebSocket = function (url, protocols) {
    let target = url;
    try {
      const parsed = new URL(url, window.location.href);
      if (/(^|\.)spatialwalk\.(cloud|top|ai)$/.test(parsed.hostname)) {
        parsed.hostname = endpoint;
        target = parsed.toString();
      }
    } catch {
      /* leave url unchanged */
    }
    return protocols === undefined
      ? new OriginalWebSocket(target)
      : new OriginalWebSocket(target, protocols);
  };
  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket = PatchedWebSocket;
}

function waitForConnection(controller) {
  return new Promise((resolve, reject) => {
    const previous = controller.onConnectionState;
    let timer = null;
    const settle = (fn, arg) => {
      if (timer) window.clearTimeout(timer);
      controller.onConnectionState = previous;
      fn(arg);
    };
    timer = window.setTimeout(() => {
      settle(reject, new Error("Timed out connecting to the avatar service."));
    }, 45000);
    controller.onConnectionState = (state) => {
      if (typeof previous === "function") previous(state);
      if (state === ConnectionState.connected) settle(resolve);
      else if (state === ConnectionState.failed) settle(reject, new Error("Connection to the avatar service failed."));
    };
  });
}

function describeAvatarError(error) {
  const code = error && error.code ? String(error.code) : "";
  const map = {
    sessionTokenInvalid: "The avatar session token was rejected. Check SPATIUS_API_KEY and region.",
    sessionTokenExpired: "The avatar session expired. Tap Start to reconnect.",
    insufficientBalance: "Your Spatius account has insufficient balance.",
    concurrentLimitExceeded: "Too many concurrent avatar connections.",
    avatarIDUnrecognized: "SPATIUS_AVATAR_ID was not recognized. Pick an avatar from your library.",
    failedToDownloadAvatarAssets: "The avatar model could not be downloaded. Check your connection."
  };
  return map[code] || (error && error.message) || "The avatar encountered an error.";
}

async function fetchSessionToken() {
  const response = await fetch("/api/spatius-token", { method: "POST" });
  const data = await response.json();
  if (!response.ok || !data.sessionToken) {
    throw new Error(data.error || "Could not obtain a Spatius session token.");
  }
  return data.sessionToken;
}

const REST = { visible: false };

// React wrapper around the real-time Spatius avatar. Exposes imperative methods
// to the parent: start(), streamPcm(), interrupt(), isReady(), setVolume().
const SpatiusAvatar = forwardRef(function SpatiusAvatar({ muted = false, onStatus }, ref) {
  const containerRef = useRef(null);
  const configRef = useRef(null);
  const viewRef = useRef(null);
  const controllerRef = useRef(null);
  const readyRef = useRef(false);
  const startingRef = useRef(false);

  // Overlay { visible, mode, title, text, progress (0..100|null), button }
  const [overlay, setOverlay] = useState({
    visible: true, mode: "loading", title: "Loading…",
    text: "Checking avatar configuration.", progress: null, button: null
  });

  useImperativeHandle(ref, () => ({
    start: startAvatar,
    streamPcm,
    interrupt,
    isReady: () => readyRef.current,
    setVolume: (v) => { try { controllerRef.current?.setVolume(v); } catch { /* ignore */ } }
  }));

  // Fetch the public Spatius config on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let config;
      try {
        const response = await fetch("/api/spatius-config");
        config = await response.json();
      } catch {
        config = { configured: false };
      }
      if (cancelled) return;
      configRef.current = config;
      if (config.configured) {
        setOverlay({
          visible: true, mode: "start", title: "Meet Amanda",
          text: "Tap to load the real-time 3D avatar. The first load downloads the avatar model.",
          progress: null, button: "Start avatar"
        });
      } else {
        setOverlay({
          visible: true, mode: "setup", title: "Avatar not configured",
          text: "Set SPATIUS_APP_ID, SPATIUS_API_KEY and SPATIUS_AVATAR_ID on the server, then reload.",
          progress: null, button: null
        });
      }
    })();
    return () => {
      cancelled = true;
      try { viewRef.current?.dispose(); } catch { /* ignore */ }
      viewRef.current = null;
      controllerRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // Keep avatar volume in sync with the mute toggle.
  useEffect(() => {
    try { controllerRef.current?.setVolume(muted ? 0 : 1); } catch { /* ignore */ }
  }, [muted]);

  async function startAvatar() {
    const config = configRef.current;
    if (startingRef.current || readyRef.current || !config || !config.configured) return;
    startingRef.current = true;

    if (viewRef.current) {
      try { viewRef.current.dispose(); } catch { /* ignore */ }
      viewRef.current = null;
      controllerRef.current = null;
    }

    try {
      setOverlay({ visible: true, mode: "loading", title: "Starting…", text: "Connecting to Spatius.", progress: 0, button: null });

      const environment = Environment[config.environment] || Environment.intl;
      if (config.apiEndpoint) installSpatiusEndpointRedirect(config.apiEndpoint);

      await AvatarSDK.initialize(config.appId, {
        environment,
        drivingServiceMode: DrivingServiceMode.sdk,
        characterApiBaseUrl: config.apiEndpoint ? `https://${config.apiEndpoint}` : undefined,
        audioFormat: { channelCount: 1, sampleRate: config.sampleRate || 24000 }
      });

      const token = await fetchSessionToken();
      AvatarSDK.setSessionToken(token);

      setOverlay({ visible: true, mode: "loading", title: "Loading avatar…", text: "Downloading the 3D avatar model.", progress: 1, button: null });

      const avatar = await AvatarManager.shared.load(config.avatarId, (info) => {
        const pct = typeof info.progress === "number" ? Math.max(1, Math.round(info.progress)) : null;
        if (pct !== null) {
          setOverlay({ visible: true, mode: "loading", title: "Loading avatar…", text: "Downloading the 3D avatar model.", progress: pct, button: null });
        }
      });

      const view = new AvatarView(avatar, containerRef.current);
      viewRef.current = view;
      controllerRef.current = view.controller;

      view.onFirstRendering = () => setOverlay(REST);

      view.controller.onConnectionState = (state) => {
        if (state === ConnectionState.disconnected || state === ConnectionState.failed) {
          readyRef.current = false;
        }
      };

      view.controller.onConversationState = (state) => {
        if (state === ConversationState.playing) onStatus?.("speaking");
        else if (state === ConversationState.idle) onStatus?.("idle");
      };

      view.controller.onError = (error) => {
        const message = describeAvatarError(error);
        readyRef.current = false;
        setOverlay({ visible: true, mode: "error", title: "Avatar error", text: message, progress: null, button: "Try again" });
        onStatus?.("error", message);
      };

      // The audio context must be created inside the user gesture (Start click).
      await view.controller.initializeAudioContext();
      view.controller.setVolume(muted ? 0 : 1);

      await view.controller.start();
      await waitForConnection(view.controller);

      readyRef.current = true;
      setOverlay(REST);
    } catch (error) {
      const message = error && error.message ? error.message : "Could not start the avatar.";
      setOverlay({ visible: true, mode: "error", title: "Avatar error", text: message, progress: null, button: "Try again" });
      onStatus?.("error", message);
    } finally {
      startingRef.current = false;
    }
  }

  // Stream PCM16 audio to the avatar in ~0.25s chunks for lip-sync + playback.
  function streamPcm(pcm) {
    const controller = controllerRef.current;
    if (!controller || !readyRef.current || !pcm || pcm.byteLength === 0) return;
    const chunkSize = 12000; // 24kHz * 2 bytes * 0.25s, kept even
    let offset = 0;
    while (offset < pcm.byteLength) {
      const end = Math.min(offset + chunkSize, pcm.byteLength);
      controller.send(pcm.slice(offset, end), end >= pcm.byteLength);
      offset = end;
    }
  }

  function interrupt() {
    if (controllerRef.current && readyRef.current) {
      try { controllerRef.current.interrupt(); } catch { /* ignore */ }
    }
  }

  return (
    <div className="avatar-frame">
      <div ref={containerRef} className="avatar-container" />
      {overlay.visible && (
        <div className={`sp-overlay sp-overlay--${overlay.mode}`}>
          <div className="sp-overlay__inner">
            <p className="sp-overlay__title">{overlay.title}</p>
            <p className="sp-overlay__text">{overlay.text}</p>
            {overlay.progress !== null && (
              <div className="sp-progress">
                <div className="sp-progress__bar" style={{ width: `${overlay.progress}%` }} />
              </div>
            )}
            {overlay.button && (
              <button className="sp-overlay__btn" type="button" onClick={startAvatar}>
                {overlay.button}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default SpatiusAvatar;
