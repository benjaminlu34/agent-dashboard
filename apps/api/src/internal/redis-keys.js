export function orchestratorRootKey(repoKey) {
  return `orchestrator:state:${repoKey}:root`;
}

export function orchestratorItemsKey(repoKey) {
  return `orchestrator:state:${repoKey}:items`;
}

export function orchestratorLedgerKey(repoKey) {
  return `orchestrator:ledger:${repoKey}`;
}

export function orchestratorControlKey(repoKey) {
  return `orchestrator:control:${repoKey}`;
}

export function orchestratorIntentQueueKey({ repoKey, role }) {
  return `orchestrator:queue:intents:${String(role).toUpperCase()}:${repoKey}`;
}

