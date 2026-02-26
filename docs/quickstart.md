# Quickstart

This guide covers the fastest setup path using the local dashboard.

## Happy Path

1. **Prerequisites**

   Install these first:

   - Node.js 18+
   - Python 3.12+
   - `pnpm`
   - A GitHub Personal Access Token (PAT) with `repo` and `project` scopes

2. **Installation**

   ```bash
   pnpm install
   pip install -r apps/runner/requirements.txt
   ```

3. **Start the control plane**

   ```bash
   pnpm dev
   ```

4. **Configure in the GUI**

   - Open `http://localhost:4000` in your browser.
   - Click **Settings** in the header.
   - Fill in:
     - `Target Owner`
     - `Target Repo`
     - `Project V2 Number`
     - `GitHub PAT`
   - Click **Save Settings**.

5. **Run preflight checks**

   Open a new terminal tab in the same repo and run:

   ```bash
   pnpm doctor
   ```

   This validates:

   - GitHub auth/token scope availability
   - Read/write access to the target repository
   - Required issue template exists at `.github/ISSUE_TEMPLATE/milestone-task.yml`

   If the template is missing, `pnpm doctor` prints exact remediation commands you can run.

6. **Initialize sprint goal in the dashboard**

   - In the dashboard, use the **Initialize Sprint** section.
   - Enter your high-level sprint objective in the textarea.
   - Click **Write Goal & Kickoff**.
   - Wait for success message: `Goal Received`.

   This writes the goal text to `goal.txt` in the repository root.

   API equivalent:

   ```bash
   curl -X POST http://localhost:4000/internal/kickoff \
     -H "content-type: application/json" \
     -d '{"goal":"Ship sprint kickoff flow with safe validation and visibility."}'
   ```

   Expected success payload:

   ```json
   { "status": "success", "message": "Goal Received." }
   ```

7. **Dry run the runner**

   ```bash
   pnpm runner:dry
   ```

   This executes a safe run without modifying the target repository.

8. **Monitor execution**

   Keep the dashboard open at `http://localhost:4000` to watch the live queue and execution states.

## Troubleshooting

- **Kickoff write fails with validation error**
  Ensure the `goal` is a non-empty string.

- **Kickoff write fails with 409**
  Run `pnpm doctor` and resolve preflight failures before retrying kickoff.

- **Doctor fails on template check**
  Follow the remediation script printed by `pnpm doctor` (the `gh repo clone ...` flow) and rerun `pnpm doctor`.

- **Doctor fails on auth**
  Verify your PAT is valid and includes the required OAuth scopes: `repo` and `project`.
