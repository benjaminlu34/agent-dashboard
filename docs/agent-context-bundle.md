## Agent Context Bundle

### Files loaded for a role (exact paths, exact order)
1. `AGENTS.md` (root governance and global constraints)
2. `agents/<ROLE>.md` (role-specific overlay for the selected role)
3. `policy/github-project.json`
4. `policy/project-schema.json`
5. `policy/transitions.json`
6. `policy/role-permissions.json`

The loader must use this order for every run and must fail fast if any required file is missing.

### Conflict resolution
- Precedence is `AGENTS.md` first, then role overlay.
- If a rule in `agents/<ROLE>.md` conflicts with `AGENTS.md`, the root rule wins.
- Role overlays are treated as narrowing guidance and cannot override root-level restrictions.
- If policy JSON conflicts with text prompts, policy JSON is authoritative for enforcement checks.

### Policy JSON delivery to the model
- `policy/*.json` is injected verbatim into the model context.
- No summarization, rewording, or lossy transformation is allowed before injection.
- Key order and array order must be preserved as stored on disk.
- Validation should confirm files are parseable JSON before injection; parse errors are hard-stop failures.

### Token/Cost Optimization
- The orchestrator may avoid re-injecting unchanged bundle file contents into the model context when `bundle_hash` is unchanged.
- In that case it must inject `bundle_hash` plus per-file hashes and rely on the previously injected content for that bundle.
- Enforcement must still use on-disk policy JSON and deny disallowed actions regardless of model context.
- Logging must always record `bundle_hash` and per-file hashes.

### Bundle hashing and versioning for logs
- Compute a deterministic bundle digest over the ordered file set above.
- Include, per file: path, byte size, and content hash in the run log.
- Record one bundle-level hash plus per-file hashes for traceability.
- Log the git branch and commit SHA used for the run.
- If working tree is dirty, log that state and still record exact file hashes.
- Persist role name, bundle hash, and timestamp together as the run’s context version marker.
