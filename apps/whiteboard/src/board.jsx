/* The heavy half of the Whiteboard App: React, Excalidraw and its stylesheet.

   build.mjs bundles this module on its own, gzips it and embeds it in the
   shell (src/extension.js) as an inert string, so Canvas pays for parsing and
   evaluating it only when someone actually opens the whiteboard. */

import { createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, MainMenu, serializeAsJSON } from "@excalidraw/excalidraw";
import styles from "@excalidraw/excalidraw/index.css";

export { serializeAsJSON };

const UI_OPTIONS = {
  canvasActions: {
    // Excalidraw's own load/save dialogs target the user's disk; the App
    // persists boards on the Agent Server instead.
    loadScene: false,
    saveToActiveFile: false,
  },
};

/* Hosts a DOM node owned by the shell (the save-status label) inside
   Excalidraw's top-right toolbar slot. */
function ShellSlot({ node }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.append(node);
    return () => node.remove();
  }, [node]);
  return createElement("div", { ref, style: { display: "flex" } });
}

function Board({ initialData, onChange, statusElement }) {
  const latest = useRef(onChange);
  latest.current = onChange;
  return createElement(Excalidraw, {
    initialData,
    langCode: "en",
    UIOptions: UI_OPTIONS,
    renderTopRightUI: statusElement ? () => createElement(ShellSlot, { node: statusElement }) : undefined,
    onChange: (elements, appState, files) => latest.current?.(elements, appState, files),
  }, createElement(BoardMenu));
}

/* Excalidraw's default main menu minus its "Excalidraw links" (social)
   section. Load/save-to-file items stay out, matching UI_OPTIONS. */
function BoardMenu() {
  const { DefaultItems, Separator } = MainMenu;
  return createElement(
    MainMenu,
    null,
    createElement(DefaultItems.Export),
    createElement(DefaultItems.SaveAsImage),
    createElement(DefaultItems.SearchMenu),
    createElement(DefaultItems.Help),
    createElement(DefaultItems.ClearCanvas),
    createElement(Separator),
    createElement(DefaultItems.ToggleTheme),
    createElement(DefaultItems.ChangeCanvasBackground),
  );
}

/** Mounts one Excalidraw instance into `element`; returns its disposer. */
export function mountBoard({ element, initialData, onChange, statusElement }) {
  const style = document.createElement("style");
  style.dataset.whiteboard = "excalidraw";
  style.textContent = styles;
  element.append(style);
  const host = document.createElement("div");
  host.className = "whiteboard-excalidraw";
  host.style.cssText = "position:absolute;inset:0";
  element.append(host);
  const root = createRoot(host);
  root.render(createElement(Board, { initialData, onChange, statusElement }));
  return () => {
    root.unmount();
    host.remove();
    style.remove();
  };
}
