import assert from "node:assert/strict";
import test from "node:test";

import { compareProjectSchema } from "../src/internal/project-schema-compare.js";

const REQUIRED_SCHEMA = {
  project_name: "Codex Task Board",
  required_fields: [
    {
      name: "Status",
      type: "single_select",
      allowed_options: ["Backlog", "Ready", "In Progress"],
    },
    {
      name: "Size",
      type: "single_select",
      allowed_options: ["S", "M", "L"],
    },
  ],
};

test("compareProjectSchema returns PASS for exact required match", () => {
  const liveSchema = {
    project_name: "Codex Task Board",
    fields: [
      { name: "Status", type: "single_select", options: ["Backlog", "Ready", "In Progress"] },
      { name: "Size", type: "single_select", options: ["S", "M", "L"] },
    ],
  };

  const result = compareProjectSchema(REQUIRED_SCHEMA, liveSchema);
  assert.deepEqual(result, { status: "PASS", mismatches: [] });
});

test("compareProjectSchema returns FAIL when a required field is missing", () => {
  const liveSchema = {
    project_name: "Codex Task Board",
    fields: [
      { name: "Status", type: "single_select", options: ["Backlog", "Ready", "In Progress"] },
    ],
  };

  const result = compareProjectSchema(REQUIRED_SCHEMA, liveSchema);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.mismatches, [
    {
      field: "Size",
      kind: "missing_field",
      expected: {
        type: "single_select",
        options: ["S", "M", "L"],
      },
    },
  ]);
});

test("compareProjectSchema returns PASS when single-select option order differs", () => {
  const liveSchema = {
    project_name: "Codex Task Board",
    fields: [
      { name: "Status", type: "single_select", options: ["Ready", "Backlog", "In Progress"] },
      { name: "Size", type: "single_select", options: ["S", "M", "L"] },
    ],
  };

  const result = compareProjectSchema(REQUIRED_SCHEMA, liveSchema);
  assert.deepEqual(result, { status: "PASS", mismatches: [] });
});

test("compareProjectSchema returns FAIL when single-select options differ by set", () => {
  const liveSchema = {
    project_name: "Codex Task Board",
    fields: [
      { name: "Status", type: "single_select", options: ["Backlog", "Ready"] },
      { name: "Size", type: "single_select", options: ["S", "M", "L"] },
    ],
  };

  const result = compareProjectSchema(REQUIRED_SCHEMA, liveSchema);
  assert.equal(result.status, "FAIL");
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].field, "Status");
  assert.equal(result.mismatches[0].kind, "options_mismatch");
});

test("compareProjectSchema returns FAIL when type differs", () => {
  const liveSchema = {
    project_name: "Codex Task Board",
    fields: [
      { name: "Status", type: "single_select", options: ["Backlog", "Ready", "In Progress"] },
      { name: "Size", type: "number", options: [] },
    ],
  };

  const result = compareProjectSchema(REQUIRED_SCHEMA, liveSchema);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.mismatches, [
    {
      field: "Size",
      kind: "wrong_type",
      expected: {
        type: "single_select",
        options: ["S", "M", "L"],
      },
      actual: {
        type: "number",
      },
    },
  ]);
});

test("compareProjectSchema supports text fields like Sprint and DependsOn", () => {
  const requiredSchema = {
    project_name: "Codex Task Board",
    required_fields: [
      ...REQUIRED_SCHEMA.required_fields,
      { name: "Sprint", type: "text" },
      { name: "DependsOn", type: "text" },
    ],
  };

  const liveSchema = {
    project_name: "Codex Task Board",
    fields: [
      { name: "Status", type: "single_select", options: ["Backlog", "Ready", "In Progress"] },
      { name: "Size", type: "single_select", options: ["S", "M", "L"] },
      { name: "Sprint", type: "text", options: [] },
      { name: "DependsOn", type: "text", options: [] },
    ],
  };

  const result = compareProjectSchema(requiredSchema, liveSchema);
  assert.deepEqual(result, { status: "PASS", mismatches: [] });
});
