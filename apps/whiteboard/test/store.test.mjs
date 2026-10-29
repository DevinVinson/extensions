import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoardStore } from "../src/store.js";

const BOARD = "/home/test/.openhands/apps/whiteboard/boards/default.excalidraw";

function fakeHost(handler) {
  const requests = [];
  return {
    requests,
    agentServer: {
      request: async (req) => {
        requests.push(req);
        if (req.path === "/api/file/home") return { home: "/home/test/" };
        return handler(req);
      },
    },
  };
}

describe("BoardStore", () => {
  it("returns null for a board that was never saved", async () => {
    const host = fakeHost(() => {
      const err = new Error("Not Found");
      err.status = 404;
      throw err;
    });
    assert.equal(await new BoardStore(host).load("default"), null);
    const download = host.requests[1];
    assert.ok(download.path.startsWith(`/api/file/download?path=${encodeURIComponent(BOARD)}&_=`));
    assert.equal(download.headers["Cache-Control"], "no-cache");
  });

  it("parses a stored .excalidraw document served as text", async () => {
    const scene = { type: "excalidraw", version: 2, elements: [{ id: "a" }], appState: {}, files: {} };
    const host = fakeHost(() => JSON.stringify(scene));
    assert.deepEqual(await new BoardStore(host).load("default"), scene);
  });

  it("rejects documents that are not Excalidraw scenes", async () => {
    const host = fakeHost(() => JSON.stringify({ type: "other" }));
    await assert.rejects(new BoardStore(host).load("default"), /not an Excalidraw document/);
  });

  it("propagates errors other than not-found", async () => {
    const host = fakeHost(() => {
      const err = new Error("Internal Server Error");
      err.status = 500;
      throw err;
    });
    await assert.rejects(new BoardStore(host).load("default"), /Internal Server Error/);
  });

  it("creates the boards directory and uploads the document", async () => {
    const host = fakeHost(() => ({}));
    await new BoardStore(host).save("default", '{"type":"excalidraw"}');
    const [, mkdir, upload] = host.requests;
    assert.equal(mkdir.method, "POST");
    assert.equal(mkdir.path, `/api/file/create_directory?path=${encodeURIComponent(BOARD.slice(0, BOARD.lastIndexOf("/")))}`);
    assert.equal(upload.method, "POST");
    assert.equal(upload.path, `/api/file/upload?path=${encodeURIComponent(BOARD)}`);
    const file = upload.body.get("file");
    assert.equal(file.name, "default.excalidraw");
    assert.equal(await file.text(), '{"type":"excalidraw"}');
  });

  it("refuses board ids that could escape the boards directory", async () => {
    const host = fakeHost(() => ({}));
    await assert.rejects(new BoardStore(host).save("../secrets", "{}"), /Invalid board id/);
    assert.equal(host.requests.length, 0);
  });

  it("requires an absolute home directory and retries after a failure", async () => {
    let calls = 0;
    const host = {
      agentServer: {
        request: async () => {
          calls += 1;
          return calls === 1 ? { home: "relative" } : { home: "/srv" };
        },
      },
    };
    const store = new BoardStore(host);
    await assert.rejects(store.root(), /absolute home/);
    assert.equal(await store.root(), "/srv/.openhands/apps/whiteboard/boards");
  });
});
