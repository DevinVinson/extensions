/* Whiteboard App shell. Kept deliberately small: it registers the page and
   owns persistence, while Excalidraw itself arrives as a gzipped payload that
   is decompressed and evaluated on the first mount (see build.mjs). */

import payload from "virtual:board-payload";
import { BOARD_ID, BoardStore } from "./store.js";

const PAGE_ID = "board";
const DEFAULT_BOARD = "default";
const SAVE_DELAY_MS = 800;
const ROOT_CLASS = "whiteboard-app";
const THEME_KEY_PREFIX = "openhands.apps.whiteboard.theme";

const STYLES = `
.${ROOT_CLASS} {
  position: relative;
  height: 100vh;
  width: 100%;
  overflow: hidden;
  color: var(--oh-foreground, #eef2f7);
  font: inherit;
}
.${ROOT_CLASS}__state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  font-size: 14px;
  color: var(--oh-muted, #a3b0c4);
}
.${ROOT_CLASS}__state[role="alert"] { color: var(--oh-danger, #e76a5e); }
.${ROOT_CLASS}__button {
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--oh-border, #4b5468);
  background: var(--oh-color-base-secondary, #21252f);
  color: var(--oh-contrast, #fff);
  font: inherit;
  cursor: pointer;
}
.${ROOT_CLASS}__button:focus-visible { outline: 2px solid var(--oh-focus, #fff); outline-offset: 2px; }
.${ROOT_CLASS}__status {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--color-gray-60, #7a7a7a);
}
.${ROOT_CLASS}__status[data-state="error"] { color: var(--color-danger, #e03131); }
`;

function decodeBase64(text) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* Decompress and evaluate the Excalidraw payload once per activation. A
   failure clears the cache so the next mount can retry. */
let boardModule = null;
function loadBoardModule() {
  if (!boardModule) {
    boardModule = (async () => {
      const bytes = decodeBase64(payload);
      const source = await new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).text();
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try {
        return await import(/* @vite-ignore */ url);
      } finally {
        URL.revokeObjectURL(url);
      }
    })().catch((err) => {
      boardModule = null;
      throw err;
    });
  }
  return boardModule;
}

/* Excalidraw reports every pointer move through onChange. Saving only when
   the drawing itself changed keeps writes proportional to edits: element
   versions increase on every edit (including deletion), files are
   append-only, and the background colour is the one document-level setting
   users commonly change. */
function sceneSignature(elements, appState, files) {
  let versions = 0;
  for (const element of elements) versions += element.version;
  return `${elements.length}:${versions}:${Object.keys(files || {}).length}:${appState.viewBackgroundColor}`;
}

/* .excalidraw files do not carry the UI theme, so it is remembered per
   viewer and backend instead. Storage can be unavailable; dark matches
   Canvas. */
function readTheme(key) {
  try {
    return localStorage.getItem(key) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function writeTheme(key, theme) {
  try {
    localStorage.setItem(key, theme);
  } catch {
    // Not persisting the theme is harmless.
  }
}

function boardIdFromPath(path) {
  const id = (path || "").replace(/^\/+|\/+$/g, "") || DEFAULT_BOARD;
  return BOARD_ID.test(id) ? id : null;
}

function stateMessage(root, text, { alert = false, action } = {}) {
  const box = document.createElement("div");
  box.className = `${ROOT_CLASS}__state`;
  if (alert) box.setAttribute("role", "alert");
  else box.setAttribute("aria-live", "polite");
  const message = document.createElement("p");
  message.style.margin = "0";
  message.textContent = text;
  box.append(message);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${ROOT_CLASS}__button`;
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    box.append(button);
  }
  root.replaceChildren(box);
}

export function activate(host) {
  if (host.apiVersion !== "1") {
    throw new Error(`Whiteboard requires Canvas host API 1, received ${host.apiVersion}.`);
  }
  const store = new BoardStore(host);
  const themeKey = `${THEME_KEY_PREFIX}:${host.backend.id}`;
  const pageRoot = `/extensions/${encodeURIComponent(host.extension.name)}/whiteboard`;

  return host.registerPage(PAGE_ID, ({ container, path, navigate }) => {
    let disposed = false;
    let unmountBoard = null;
    let saveTimer = null;
    let pending = null; // latest unsaved serialization
    let lastSignature = null;
    let saving = Promise.resolve();

    const style = document.createElement("style");
    style.dataset.whiteboard = "shell";
    style.textContent = STYLES;
    const root = document.createElement("div");
    root.className = ROOT_CLASS;
    container.append(style, root);

    const status = document.createElement("span");
    status.className = `${ROOT_CLASS}__status`;
    status.setAttribute("role", "status");
    const setStatus = (state, text) => {
      status.dataset.state = state;
      status.textContent = text;
    };

    const boardId = boardIdFromPath(path);
    if (!boardId) {
      stateMessage(root, `"${path}" is not a valid board name.`, {
        alert: true,
        action: { label: "Open the default board", onClick: () => navigate(pageRoot) },
      });
      return () => {
        disposed = true;
        root.remove();
        style.remove();
      };
    }

    const flush = () => {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (!pending) return saving;
      const json = pending;
      pending = null;
      saving = saving
        .then(() => store.save(boardId, json))
        .then(
          () => { if (!disposed && !pending) setStatus("saved", "Saved"); },
          (err) => {
            // Keep the newest unsaved scene so the next edit or unmount retries it.
            pending ??= json;
            if (!disposed) setStatus("error", `Save failed: ${err.message}`);
          },
        );
      return saving;
    };

    const start = async () => {
      stateMessage(root, "Loading whiteboard…");
      try {
        const [board, scene] = await Promise.all([loadBoardModule(), store.load(boardId)]);
        if (disposed) return;
        root.replaceChildren();
        setStatus("saved", scene ? "Saved" : "New board");
        let theme = readTheme(themeKey);
        const initialData = {
          elements: scene?.elements ?? [],
          appState: { ...scene?.appState, theme },
          files: scene?.files ?? {},
        };
        unmountBoard = board.mountBoard({
          element: root,
          initialData,
          statusElement: status,
          onChange: (elements, appState, files) => {
            if (appState.theme !== theme) {
              theme = appState.theme;
              writeTheme(themeKey, theme);
            }
            const signature = sceneSignature(elements, appState, files);
            if (lastSignature === null) {
              // Excalidraw's first onChange reflects the loaded scene.
              lastSignature = signature;
              return;
            }
            if (signature === lastSignature) return;
            lastSignature = signature;
            pending = board.serializeAsJSON(elements, appState, files, "local");
            setStatus("saving", "Saving…");
            clearTimeout(saveTimer);
            saveTimer = setTimeout(flush, SAVE_DELAY_MS);
          },
        });
      } catch (err) {
        if (disposed) return;
        stateMessage(root, `Unable to open the whiteboard: ${err.message}`, {
          alert: true,
          action: { label: "Try again", onClick: start },
        });
      }
    };
    start();

    return () => {
      disposed = true;
      // Persist the last edits even when the user navigates away mid-delay.
      flush();
      unmountBoard?.();
      root.remove();
      style.remove();
    };
  });
}

export const __testing = { PAGE_ID, sceneSignature, boardIdFromPath, loadBoardModule };
