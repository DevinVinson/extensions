/* Whiteboard persistence on the owning Agent Server.

   Each board is one standard `.excalidraw` JSON document below
   <agent-server-home>/.openhands/apps/whiteboard/boards/, so it can be opened
   in excalidraw.com or read by an agent working on the same server. Only the
   Agent Server file API is used; the App never reads Canvas credentials. */

const STORE_SUBPATH = ".openhands/apps/whiteboard/boards";
export const BOARD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isNotFound(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 404) return true;
  return /\b404\b|not found/i.test(err?.message || "");
}

export class BoardStore {
  constructor(host) {
    this.host = host;
    this.rootPromise = null;
  }

  /** Absolute boards directory, resolved from the server's home once. */
  root() {
    if (!this.rootPromise) {
      this.rootPromise = this.host.agentServer
        .request({ path: "/api/file/home" })
        .then((res) => {
          const home = (typeof res === "string" ? JSON.parse(res) : res)?.home;
          if (typeof home !== "string" || !home.startsWith("/")) {
            throw new Error("The Agent Server did not report an absolute home directory.");
          }
          return `${home.replace(/\/+$/, "")}/${STORE_SUBPATH}`;
        })
        .catch((err) => {
          this.rootPromise = null;
          throw err;
        });
    }
    return this.rootPromise;
  }

  async boardPath(id) {
    if (!BOARD_ID.test(id)) throw new Error(`Invalid board id: ${id}`);
    return `${await this.root()}/${id}.excalidraw`;
  }

  /** The stored scene, or null when the board has never been saved. */
  async load(id) {
    const path = await this.boardPath(id);
    let raw;
    try {
      // The file API sends no Cache-Control; never reuse a stale board.
      raw = await this.host.agentServer.request({
        path: `/api/file/download?path=${encodeURIComponent(path)}&_=${Date.now()}`,
        headers: { "Cache-Control": "no-cache" },
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const scene = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!scene || scene.type !== "excalidraw" || !Array.isArray(scene.elements)) {
      throw new Error(`${path} is not an Excalidraw document.`);
    }
    return scene;
  }

  /** Writes `json` (a serialized .excalidraw document) as the board. */
  async save(id, json) {
    const path = await this.boardPath(id);
    const dir = path.slice(0, path.lastIndexOf("/"));
    await this.host.agentServer.request({
      method: "POST",
      path: `/api/file/create_directory?path=${encodeURIComponent(dir)}`,
    });
    const form = new FormData();
    form.append("file", new Blob([json], { type: "application/json" }), `${id}.excalidraw`);
    await this.host.agentServer.request({
      method: "POST",
      path: `/api/file/upload?path=${encodeURIComponent(path)}`,
      body: form,
    });
  }
}
