import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAgentContextBundle } from "../agent-context-loader.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../../");
const BUNDLE_ROLES = ["ORCHESTRATOR", "EXECUTOR", "REVIEWER"];

function normalizeRole(role) {
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

function includesRole(allowedRoles, role) {
  const normalized = normalizeRole(role);
  return allowedRoles.some((candidate) => normalizeRole(candidate) === normalized);
}

async function loadPolicies(repoRoot = DEFAULT_REPO_ROOT) {
  let bundle = null;
  let lastError = null;

  for (const role of BUNDLE_ROLES) {
    try {
      bundle = await loadAgentContextBundle({ repoRoot, role });
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!bundle) {
    throw lastError;
  }

  const byPath = new Map(bundle.files.map((file) => [file.path, file.content]));

  return {
    rolePermissions: JSON.parse(byPath.get("policy/role-permissions.json")),
    transitions: JSON.parse(byPath.get("policy/transitions.json")).transitions ?? [],
  };
}

const POLICY_DATA = await loadPolicies();

function findRolePermissions(rolePermissions, role) {
  const normalized = normalizeRole(role);
  const match = Object.entries(rolePermissions).find(([key]) => normalizeRole(key) === normalized);
  return match ? match[1] : null;
}

function normalizeCapabilityMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean"));
}

export function isRoleAllowed(role, permissionFlag) {
  const { rolePermissions } = POLICY_DATA;
  const permissions = findRolePermissions(rolePermissions, role);
  if (!permissions) {
    return false;
  }
  return permissions[permissionFlag] === true;
}

export function isStatusTransitionAllowed(role, fromStatus, toStatus) {
  const { transitions } = POLICY_DATA;
  return evaluateStatusTransition({ transitions, role, fromStatus, toStatus });
}

function evaluateStatusTransition({ transitions, role, fromStatus, toStatus }) {
  const transition =
    transitions.find((item) => item.from === fromStatus && item.to === toStatus) ??
    transitions.find((item) => item.from === "*" && item.to === toStatus);

  if (!transition) {
    return { allowed: false, automation_allowed: false };
  }

  const allowedRoles = Array.isArray(transition.allowed_roles) ? transition.allowed_roles : [];
  const allowed = includesRole(allowedRoles, role);
  const automationAllowed = transition.automation_allowed !== false;

  return {
    allowed,
    automation_allowed: automationAllowed,
  };
}

export async function getRolePermissions(role, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const { rolePermissions } = await loadPolicies(repoRoot);
  const permissions = findRolePermissions(rolePermissions, role);
  if (!permissions || typeof permissions !== "object") {
    return {};
  }
  return permissions;
}

export async function getAllowedCapabilities(role, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const permissions = await getRolePermissions(role, { repoRoot });
  return normalizeCapabilityMap(permissions);
}

export async function isRoleAllowedForRepo(role, permissionFlag, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const permissions = await getRolePermissions(role, { repoRoot });
  return permissions[permissionFlag] === true;
}

export async function isStatusTransitionAllowedForRepo(
  role,
  fromStatus,
  toStatus,
  { repoRoot = DEFAULT_REPO_ROOT } = {},
) {
  const { transitions } = await loadPolicies(repoRoot);
  return evaluateStatusTransition({ transitions, role, fromStatus, toStatus });
}
