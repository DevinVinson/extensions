/* Load the checked-in bundle the way Canvas does (Blob URL import) in headless
   Chrome, then: open a stored board, draw a rectangle, confirm the autosave
   upload, create a board from the picker with real keystrokes (which must not
   reach Excalidraw's shortcuts), dispose, and remount. Set CHROME_PATH if
   Chrome is elsewhere. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(here, "..", "canvas-extension.json"), "utf8"));
const bundle = readFileSync(join(here, "..", MANIFEST.entrypoint), "utf8");
const chrome = process.env.CHROME_PATH
  ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome"]
    .find((path) => existsSync(path));
if (!chrome) throw new Error("Chrome not found; set CHROME_PATH.");

const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("request", (req) => {
    if (!req.url().startsWith("data:") && !req.url().startsWith("blob:") && req.url() !== "about:blank") {
      errors.push(`unexpected network request: ${req.url()}`);
    }
  });
  await page.setContent("<!doctype html><html><head></head><body style='margin:0'><div id='mount'></div></body></html>");

  await page.evaluate(async (source) => {
    const stored = {
      type: "excalidraw",
      version: 2,
      source: "smoke",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    window.smoke = { uploads: [], files: new Map(), navigations: [], registrations: new Map() };
    const host = {
      apiVersion: "1",
      extension: { name: "whiteboard", version: "0.0.0", resolvedRef: "smoke" },
      backend: { id: "smoke", kind: "local", orgId: null },
      registerPage(id, mount) {
        window.smoke.registrations.set(id, mount);
        return () => window.smoke.registrations.delete(id);
      },
      navigate() {},
      agentServer: {
        async request({ path, body }) {
          const target = new URL(path, "http://x").searchParams.get("path");
          if (path === "/api/file/home") return { home: "/home/smoke" };
          if (path.startsWith("/api/file/download")) {
            if (target.endsWith("/default/board.excalidraw")) return JSON.stringify(stored);
            if (window.smoke.files.has(target)) return window.smoke.files.get(target);
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
          if (path.startsWith("/api/file/search_subdirs")) {
            const names = new Set(["default"]);
            for (const file of window.smoke.files.keys()) names.add(file.slice(target.length + 1).split("/")[0]);
            return { items: [...names].map((name) => ({ name, path: `${target}/${name}` })), next_page_id: null };
          }
          if (path.startsWith("/api/file/upload")) {
            const text = await body.get("file").text();
            window.smoke.files.set(target, text);
            if (target.endsWith("/board.excalidraw")) window.smoke.uploads.push(text);
          }
          return {};
        },
      },
    };
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const module = await import(url);
    URL.revokeObjectURL(url);
    window.smoke.deactivate = module.activate(host);
    window.smoke.mount = () => window.smoke.registrations.get("board")({
      container: document.querySelector("#mount"),
      path: "",
      navigate: (to) => window.smoke.navigations.push(to),
    });
    window.smoke.cleanup = window.smoke.mount();
  }, bundle);

  await page.waitForSelector(".excalidraw canvas", { timeout: 15000 });
  await page.waitForSelector(".whiteboard-app__status[data-state='saved']");

  await page.click('label:has([data-testid="toolbar-rectangle"])');
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(700, 450, { steps: 5 });
  await page.mouse.up();
  await page.waitForFunction(() => window.smoke.uploads.length > 0, null, { timeout: 5000 });
  const saved = JSON.parse(await page.evaluate(() => window.smoke.uploads.at(-1)));
  if (saved.type !== "excalidraw" || saved.elements.filter((e) => e.type === "rectangle").length !== 1) {
    throw new Error(`Autosave did not contain the drawn rectangle: ${JSON.stringify(saved.elements)}`);
  }

  // At desktop width the picker sits beside Excalidraw's main-menu button.
  const placement = await page.$eval(".whiteboard-picker", (node) => ({
    placement: node.dataset.placement,
    besideMenu: !!node.parentElement?.querySelector(".main-menu-trigger, .dropdown-menu-button"),
  }));
  if (placement.placement !== "menu" || !placement.besideMenu) {
    throw new Error(`Board picker is not next to the main menu: ${JSON.stringify(placement)}`);
  }
  await page.click(".whiteboard-picker__trigger");
  await page.waitForSelector(".whiteboard-picker__item[aria-current='page']");
  await page.click(".whiteboard-picker__input");
  await page.keyboard.type("Sprint plan");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.smoke.navigations.length > 0, null, { timeout: 5000 });
  const created = await page.evaluate(() => ({
    navigations: window.smoke.navigations,
    meta: [...window.smoke.files].find(([file]) => file.endsWith("/meta.json") && !file.includes("/default/")),
    selectionTool: document.querySelector("[data-testid='toolbar-selection']")?.checked,
  }));
  if (!/^\/extensions\/whiteboard\/boards\/sprint-plan-[a-z0-9]{4}$/.test(created.navigations[0])) {
    throw new Error(`Picker did not open the new board: ${JSON.stringify(created.navigations)}`);
  }
  if (!created.meta || JSON.parse(created.meta[1]).title !== "Sprint plan") {
    throw new Error("Picker did not store the new board's title.");
  }
  // Typing "Sprint plan" into Excalidraw would have switched tools ("a" = arrow, "l" = line).
  if (!created.selectionTool) throw new Error("Picker keystrokes leaked into Excalidraw shortcuts.");

  const leftovers = await page.evaluate(() => {
    window.smoke.cleanup();
    return document.querySelector("#mount").childElementCount
      + document.querySelectorAll("style[data-whiteboard]").length;
  });
  if (leftovers !== 0) throw new Error("Mount cleanup left DOM or styles behind.");

  const remountMs = await page.evaluate(async () => {
    const start = performance.now();
    window.smoke.cleanup = window.smoke.mount();
    while (!document.querySelector(".excalidraw canvas")) await new Promise((r) => setTimeout(r, 5));
    const elapsed = performance.now() - start;
    window.smoke.cleanup();
    window.smoke.deactivate();
    return elapsed;
  });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Blob smoke OK: render, draw, autosave, create board, dispose, remount (${Math.round(remountMs)} ms).`);
} finally {
  await browser.close();
}
