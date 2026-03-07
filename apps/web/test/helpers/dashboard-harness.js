import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "../../../..");
const DASHBOARD_HTML_PATH = resolve(REPO_ROOT, "apps/web/public/index.html");
const DASHBOARD_APP_URL = pathToFileURL(resolve(REPO_ROOT, "apps/web/public/js/dashboard/app.js")).href;

function createNoopCanvasContext() {
  return {
    setTransform() {},
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    arc() {},
    fill() {},
  };
}

function createStorage(initialValues = {}) {
  const store = new Map(Object.entries(initialValues).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
    snapshot() {
      return Object.fromEntries(store.entries());
    },
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

class EventSourceMock {
  static instances = [];

  constructor(url) {
    this.url = String(url);
    this.closed = false;
    this.onerror = null;
    this._listeners = new Map();
    EventSourceMock.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) ?? [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(type, payload) {
    const listeners = this._listeners.get(type) ?? [];
    const event = { data: JSON.stringify(payload) };
    for (const listener of listeners) {
      listener(event);
    }
  }

  triggerError() {
    if (typeof this.onerror === "function") {
      this.onerror(new Error("event source failure"));
    }
  }
}

export async function createDashboardHarness({
  configPayload = {
    targetOwner: "test-owner",
    targetRepo: "test-repo",
    projectNumber: 7,
    maxExecutors: 2,
    maxReviewers: 1,
    hasGithubToken: false,
  },
  statusPayload = {
    orchestrator: {},
    runner: {},
  },
  statusHeaders = {
    "x-target-owner": "test-owner",
    "x-target-repo": "test-repo",
  },
  logSnapshots = {},
  fetchHandler,
  storageValues = {},
  terminalStreamReconnectMs = 25,
  pollIntervalMs = 60_000,
} = {}) {
  const html = await readFile(DASHBOARD_HTML_PATH, "utf8");
  const dom = new JSDOM(html, {
    url: "http://localhost:4000/",
    pretendToBeVisual: true,
  });

  dom.window.HTMLCanvasElement.prototype.getContext = () => createNoopCanvasContext();
  dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  dom.window.cancelAnimationFrame = (frameId) => clearTimeout(frameId);

  EventSourceMock.instances.length = 0;

  let hidden = false;
  const storage = createStorage(storageValues);
  const requests = [];

  const fetchImpl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    requests.push({ url, init });
    if (typeof fetchHandler === "function") {
      const customResponse = await fetchHandler({ url, init, requests });
      if (customResponse) {
        return customResponse;
      }
    }

    if (url === "/internal/config") {
      return jsonResponse(configPayload);
    }
    if (url === "/internal/status") {
      return jsonResponse(statusPayload, { headers: statusHeaders });
    }
    if (url.startsWith("/internal/logs/")) {
      const runId = decodeURIComponent(url.replace("/internal/logs/", ""));
      const next = logSnapshots[runId];
      if (next instanceof Response) {
        return next;
      }
      if (next && typeof next === "object" && "status" in next) {
        return jsonResponse(next.body ?? {}, { status: next.status, headers: next.headers ?? {} });
      }
      return jsonResponse(next ?? { logs: "", seq: 0, role: "" });
    }
    throw new Error(`Unhandled fetch in dashboard harness: ${url}`);
  };

  const { bootstrapDashboard } = await import(DASHBOARD_APP_URL);
  const app = bootstrapDashboard({
    window: dom.window,
    document: dom.window.document,
    fetch: fetchImpl,
    EventSource: EventSourceMock,
    localStorage: storage,
    isDocumentHidden: () => hidden,
    pollIntervalMs,
    terminalStreamReconnectMs,
    backgroundAnimatorFactory: () => ({
      resize() {},
      start() {},
      stop() {},
      setActivityFromData() {},
      setActivityTarget() {},
    }),
    createAudioContext: () => null,
    confirm: () => true,
  });

  return {
    app,
    window: dom.window,
    document: dom.window.document,
    storage,
    requests,
    eventSources: EventSourceMock.instances,
    setHidden(nextHidden) {
      hidden = Boolean(nextHidden);
    },
    async tick(ms = 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    destroy() {
      app.destroy();
      dom.window.close();
    },
  };
}
