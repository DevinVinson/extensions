/* Load the checked-in bundle the way Canvas does (Blob URL import) in headless
   Chrome, then: open a stored board, draw a rectangle, confirm the autosave
   upload, dispose, and remount. Set CHROME_PATH if Chrome is elsewhere. */

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
    window.smoke = { uploads: [], registrations: new Map() };
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
          if (path === "/api/file/home") return { home: "/home/smoke" };
          if (path.startsWith("/api/file/download")) return JSON.stringify(stored);
          if (path.startsWith("/api/file/upload")) window.smoke.uploads.push(await body.get("file").text());
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
      navigate() {},
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
  console.log(`Blob smoke OK: render, draw, autosave, dispose, remount (${Math.round(remountMs)} ms).`);
} finally {
  await browser.close();
}
