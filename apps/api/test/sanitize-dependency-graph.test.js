import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDependencyGraph } from "../../orchestrator/src/sanitize-dependency-graph.js";

function createItem({
  number,
  isolation_mode = "CHAINED",
  depends_on = [],
  owns_paths = [],
  touch_paths = [],
} = {}) {
  return {
    number,
    isolation_mode,
    depends_on,
    owns_paths,
    touch_paths,
  };
}

test("sanitizeDependencyGraph keeps a clean chained graph unchanged", () => {
  const input = [
    createItem({ number: 1, depends_on: [], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/server.js"] }),
    createItem({ number: 2, depends_on: [1], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/routes"] }),
    createItem({ number: 3, depends_on: [2], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/db"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items, input);
  assert.deepEqual(result.report, { droppedEdges: [], cycles: null });
});

test("sanitizeDependencyGraph drops dead references", () => {
  const input = [
    createItem({ number: 10, depends_on: [999], owns_paths: ["apps/api"], touch_paths: ["apps/api/src"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].depends_on, []);
  assert.deepEqual(result.report.droppedEdges, [{ from: 10, to: 999, reason: "DEAD_REF" }]);
});

test("sanitizeDependencyGraph drops doc-only blockers for non-doc dependers", () => {
  const input = [
    createItem({ number: 11, depends_on: [12], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/handler.js"] }),
    createItem({ number: 12, depends_on: [], owns_paths: ["apps/api"], touch_paths: ["docs/guide.md", "notes/readme.txt"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].depends_on, []);
  assert.deepEqual(result.report.droppedEdges, [{ from: 11, to: 12, reason: "DOC_BLOCKER" }]);
});

test("sanitizeDependencyGraph keeps doc task depending on doc task", () => {
  const input = [
    createItem({ number: 13, depends_on: [14], owns_paths: ["docs"], touch_paths: ["docs/plan.md"] }),
    createItem({ number: 14, depends_on: [], owns_paths: ["docs"], touch_paths: ["docs/spec.rst"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].depends_on, [14]);
  assert.deepEqual(result.report.droppedEdges, []);
});

test("sanitizeDependencyGraph drops dependencies with no owns_paths overlap", () => {
  const input = [
    createItem({ number: 20, depends_on: [21], owns_paths: ["apps/api"], touch_paths: ["apps/api/src"] }),
    createItem({ number: 21, depends_on: [], owns_paths: ["apps/web"], touch_paths: ["apps/web/src"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].depends_on, []);
  assert.deepEqual(result.report.droppedEdges, [{ from: 20, to: 21, reason: "NO_OVERLAP" }]);
});

test("sanitizeDependencyGraph keeps dependencies when owns_paths share prefix overlap", () => {
  const input = [
    createItem({ number: 22, depends_on: [23], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/routes"] }),
    createItem({ number: 23, depends_on: [], owns_paths: ["apps/api/src"], touch_paths: ["apps/api/src/db"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].depends_on, [23]);
  assert.deepEqual(result.report.droppedEdges, []);
});

test("sanitizeDependencyGraph skips no-overlap pruning when either owns_paths is empty", () => {
  const input = [
    createItem({ number: 24, depends_on: [25], owns_paths: [], touch_paths: ["apps/api/src"] }),
    createItem({ number: 25, depends_on: [], owns_paths: ["apps/web"], touch_paths: ["apps/web/src"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.equal(result.error, null);
  assert.deepEqual(result.items[0].depends_on, [25]);
  assert.deepEqual(result.report.droppedEdges, []);
});

test("sanitizeDependencyGraph detects a two-node cycle", () => {
  const input = [
    createItem({ number: 30, depends_on: [31], owns_paths: ["apps/api"], touch_paths: ["apps/api/src"] }),
    createItem({ number: 31, depends_on: [30], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/routes"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.notEqual(result.error, null);
  assert.deepEqual(result.error.cycles, [[30, 31]]);
  assert.deepEqual(result.report.cycles, [[30, 31]]);
});

test("sanitizeDependencyGraph detects a three-node cycle", () => {
  const input = [
    createItem({ number: 40, depends_on: [41], owns_paths: ["apps/api"], touch_paths: ["apps/api/src"] }),
    createItem({ number: 41, depends_on: [42], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/routes"] }),
    createItem({ number: 42, depends_on: [40], owns_paths: ["apps/api"], touch_paths: ["apps/api/src/db"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.notEqual(result.error, null);
  assert.deepEqual(result.error.cycles, [[40, 41, 42]]);
  assert.deepEqual(result.report.cycles, [[40, 41, 42]]);
});

test("sanitizeDependencyGraph returns cycle error after partial pruning in mixed case", () => {
  const input = [
    createItem({ number: 50, depends_on: [999, 51, 54], owns_paths: ["apps/api"], touch_paths: ["apps/api/src"] }),
    createItem({ number: 51, depends_on: [52], owns_paths: ["apps/web"], touch_paths: ["apps/web/src"] }),
    createItem({ number: 52, depends_on: [51], owns_paths: ["apps/web/src"], touch_paths: ["apps/web/src/routes"] }),
    createItem({ number: 54, depends_on: [], owns_paths: ["docs"], touch_paths: ["docs/readme.md"] }),
  ];

  const result = sanitizeDependencyGraph(input);
  assert.notEqual(result.error, null);
  assert.deepEqual(result.report.droppedEdges, [
    { from: 50, to: 999, reason: "DEAD_REF" },
    { from: 50, to: 51, reason: "NO_OVERLAP" },
    { from: 50, to: 54, reason: "DOC_BLOCKER" },
  ]);
  assert.deepEqual(result.error.cycles, [[51, 52]]);
  assert.deepEqual(result.items.find((item) => item.number === 50)?.depends_on, []);
  assert.deepEqual(result.items.find((item) => item.number === 51)?.depends_on, [52]);
  assert.deepEqual(result.items.find((item) => item.number === 52)?.depends_on, [51]);
});
