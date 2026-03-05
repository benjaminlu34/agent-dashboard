# Quickstart

This guide covers the fastest setup path using the local dashboard.

## Happy Path

1. **Prerequisites**

   Install these first:

   - Node.js 18+
   - Python 3.12+
   - `pnpm`
   - Redis 7+ reachable at `REDIS_URL` (default `redis://localhost:6379/0`)
   - A GitHub Personal Access Token (PAT) with `repo` and `project` scopes

2. **Installation**

   ```bash
   pnpm install
   pip install -r apps/runner/requirements.txt
   ```

3. **Install and start Redis**

   ```bash
   sudo apt update
   sudo apt install -y redis-server
   sudo service redis-server start
   ```

   Check status:

   ```bash
   sudo service redis-server status
   ```

   Use the default connection string unless you are running Redis elsewhere:

   ```bash
   export REDIS_URL=redis://localhost:6379/0
   ```

   If you start Redis with `redis-server --port 6379`, it only stays up for that shell session. Using `sudo service redis-server start` runs it in the background.

4. **Start the control plane**

   ```bash
   pnpm dev
   ```

5. **Configure via GUI**

   - Open `http://localhost:4000` in your browser.
   - Click **Settings** in the header.
   - Fill in:
     - `Target Owner`
     - `Target Repo`
     - `Project V2 Number`
     - `GitHub PAT`
   - Notes:
     - **Target Owner:** Use the organization or username slug (e.g., `openai`).
     - **Target Repo:** Use the repository name slug (e.g., `whisper`).
     - **Important:** Do not paste full URLs into these fields.
   - Click **Save Settings**.

6. **Run preflight checks**

   Open a new terminal tab in the same repo and run:

   ```bash
   pnpm doctor
   ```

   This validates:

   - GitHub auth/token scope availability
   - Read/write access to the target repository
   - Required issue template exists at `.github/ISSUE_TEMPLATE/milestone-task.yml`

   If the template is missing, `pnpm doctor` prints exact remediation commands you can run.

7. **Initialize sprint and start kickoff loop in the dashboard**

   - In the dashboard, use the **Initialize Sprint** section.
   - Enter your high-level sprint objective in the textarea.
   - Click **Save Goal (Step 1)**.
   - Set `Sprint` to `M1`, `M2`, `M3`, or `M4`.
   - Click **Start Kickoff Loop (Step 2)**.
   - Wait for success message: `Kickoff loop started.`

   This writes `goal.txt` and starts the live kickoff loop from the GUI.

   API equivalents:

   ```bash
   curl -X POST http://localhost:4000/internal/kickoff \
     -H "content-type: application/json" \
     -d '{"goal":"Ship sprint kickoff flow with safe validation and visibility."}'

   curl -X POST http://localhost:4000/internal/kickoff/start-loop \
     -H "content-type: application/json" \
     -d '{"sprint":"M1"}'
   ```

   Expected success payloads:

   ```json
   { "status": "success", "message": "Goal Received." }
   { "status": "STARTED", "message": "Kickoff loop started.", "pid": 12345, "sprint": "M1", "started_at": "..." }
   ```

8. **(Optional) Dry run the runner**

   ```bash
   pnpm runner:dry
   ```

   This executes a safe run without modifying the target repository.

9. **CLI fallback for live workflow execution**

   ```bash
   python3 -m apps.runner --kickoff --sprint M1 --goal-file ./goal.txt --loop
   ```

   Use this only if you do not start from the GUI button in step 6.

10. **Monitor execution**

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

- **`pnpm dev` fails with `connect ECONNREFUSED 127.0.0.1:6379`**
  Redis is not running or `REDIS_URL` is pointing at the wrong instance. Start Redis first, then retry `pnpm dev`.
