---
name: coding-agent
description: Workflow, CLI tool usage, self-stamping, and task lifecycle for coding agents executing issues assigned by the Orchestrator on Forgejo
---

# Coding Agent Skill

This skill defines the operational workflow, tool usage, issue conventions, and reporting standards for **coding agents** operating behind the shared `@xpufx` user identity.

> [!IMPORTANT]
> **Worker Scope: Assigned Work Only**: A coding agent operates **strictly on the assigned ticket and launch contract provided by the Orchestrator**. If no assigned ticket or launch contract is present, **stop immediately and report/escalate** — never scan, rank, triage, or self-claim unassigned board work. Board prioritization, triage, and dispatch are exclusively the Orchestrator's responsibility (see `skills/orchestrator/SKILL.md`).

> [!IMPORTANT]
> **Token Economy Rule**: If you explained or documented something in a Forgejo issue comment, **keep conversation responses in the agent/user harness strictly brief and low-token**. Point directly to the issue number/link; do not duplicate long explanations into chat.

> [!IMPORTANT]
> **Comment Budget**: Keep issue comments to **one screen (~15 lines)**. Lead with what changed + commit SHA + test result; put analysis/checklists/design detail in the issue **body** (or a linked child issue), not a comment. Never paste diffs, full test output, or re-explain referenced code. One comment per handoff — no per-step play-by-step narration.

> [!IMPORTANT]
> **Plugin Storage Isolation**:
> When implementing, modifying, or refactoring Paseo plugins, persistent data, configuration, queues, and state must **NEVER** be stored in arbitrary locations under `~/.paseo/` (e.g. `~/.paseo/logs`, `~/.paseo/queues`) or under `~/.config/<plugin>`. All plugin persistent state must be scoped strictly under `~/.paseo/plugin-data/<namespace>/<pluginId>/` via `PluginStorage`.

---

## 1. Primary Tool: `teax`

Interact with the Forgejo task board using `teax` (available in `$PATH`).
**Rule**: `teax` is the single authoritative Forgejo CLI for agents. It wraps the underlying Forgejo/Gitea client (including `teax api ...`) while adding display enhancements (labels, formatting, envelope stamping, paginated label handling).

**Precedence**: `teax` is the **only** supported Forgejo CLI for agent board work — use it for every issue, PR, label, and comment operation. There is no alternative board tool and no second wrapper to choose between. Never invoke the underlying client directly; it lacks label pagination, name-to-ID lookup, and envelope stamping, and it is not on `$PATH` for agents by design.

- **Host**: `forge.mrs.uppidi.com`
- **Repo**: `xpufx-org/paseo` (or target repo in `owner/repo` format)

### Essential Commands

```bash
# List open issues with labels
teax --hostname forge.mrs.uppidi.com -R xpufx-org/paseo issue list

# View issue details, labels, and formatted comment history
teax --hostname forge.mrs.uppidi.com -R xpufx-org/paseo issue view <NUMBER>

# Post a comment with auto agent-envelope self-stamp
teax issue comment <NUMBER> --hostname forge.mrs.uppidi.com -R xpufx-org/paseo --envelope -b "Comment text"

# Call raw API via teax (never invoke the underlying client directly)
teax api repos/xpufx-org/paseo/issues/<NUMBER> --hostname forge.mrs.uppidi.com
```

> [!IMPORTANT]
> **Clean Markdown & Backticks**: When posting comments via shell or heredocs, do NOT double-escape backticks with backslashes (e.g. avoid `\`\`\`` or `\`code\``). Backslashes display literally on the Forgejo web UI. Use unescaped single quotes, heredocs (`cat << 'EOF'`), or raw file input (`-F file` or python) to preserve clean triple backticks (` ``` `).

> [!NOTE]
> Forgejo (`forge.mrs.uppidi.com`) is the **primary git remote (`origin`) and issues tracker**. All agent code pushes go to `origin` on Forgejo. Pushes to public GitHub are strictly manual and gated by human review.

---

## 2. Issue Referencing & Linking Conventions

When referencing issues in comments, commit messages, or chat harness:
1. **Instance-Qualified Links**: We may have multiple Forgejo/Git instances. Always format issue references with clickable markdown URLs including the instance descriptor, for example:
   `[Issue #47 (forge.mrs)](https://forge.mrs.uppidi.com/xpufx-org/paseo/issues/47)`
2. **Never echo redundant issue numbers**: Do not post naked `#47` inside comments on issue #47 itself without additional context. Reference external/cross-issue links with their full URL and repo/forge context.

---

## 3. Paseo Workspace and Commit Tracking Standard

> [!IMPORTANT]
> **Strict Protected `main` & No Direct Pushes**:
> Fleet repositories enforce branch protection on `main`. Direct pushes to `main` are strictly forbidden and will be rejected. All code changes must originate from the isolated Paseo workspace assigned by the Orchestrator and be delivered via a Pull Request.

1. **Workspace Safety Preflight**:
   Before reading or editing project files, require the Orchestrator's launch contract to identify the assigned `workspace_id`, absolute `workspace_path`, and workspace branch. Verify that the current directory matches that path and is an isolated linked Git worktree, not the primary checkout. Use read-only checks such as `git rev-parse` and `git worktree list`.

   If the contract is missing, the path or worktree does not match, or the workspace cannot be verified, stop immediately. Report that no valid Paseo workspace is assigned and ask the Orchestrator to provision or repair it. Do not edit files, create or switch workspaces, create or delete worktrees, or create, rename, switch, or delete branches as a workaround.

2. **Paseo Owns Workspace Lifecycle**:
   Work only in the assigned Paseo workspace. Paseo/the Orchestrator owns workspace, worktree, and branch creation, naming, switching, archival, and deletion. The worker records the assigned workspace ID, branch ref, exact commit SHA, and remote in its handoff.

3. **Push Feature Branch & Open PR**:
   Push the already-assigned branch to `origin`:
   ```bash
   git push origin HEAD
   ```
   Open a Pull Request via `teax pr create` and immediately post a stamped envelope comment to the PR so the author agent instance is identified in the Forgejo GUI:
   ```bash
   teax pr create -t "<type>(<scope>): <title> (#<issue#>)" -b "Refs #<issue#>\n\n<Summary of changes and test results>" -B main -H <branch-name>
   teax issue comment <pr#> -R <repo> --hostname forge.mrs.uppidi.com --envelope -b "### PR Opened\nRefs #<issue#>\n- Branch: \`<branch-name>\`\n- Summary: <concise summary>"
   ```
4. **Public Mirroring**: Never push directly to GitHub without human instruction; code stays on Forgejo `origin`. For external repositories (like `paseo-x-comms`), state the repository origin remote + branch + SHA explicitly.
5. **Anchored resolution explanations**: Post the why + commit ref + PR link on the resolved issue itself, never as a loose top-level thread elsewhere.

---

## 4. Mandatory: Self-Stamping with Agent Envelope

All agents share authentication under `@xpufx`. Because the Orchestrator does **not** have access to your local agent environment, **you must stamp every issue comment and status update with your own agent envelope** (use `teax issue comment <id> --envelope -b ...`).

The envelope generator is powered by `xpufx-tool envelope` (available in `$PATH`).

### Strict Channel Hygiene & Human-Visible Markdown

> [!CAUTION]
> **Zero Wire Envelopes in Issue Comments**: Issue and PR comments are strictly for human readers in Markdown.
> - NEVER emit `<x-comms-message>`, `<x-comms>`, raw XML tags, or raw JSON RPC payloads into issue or PR comments.
> - Always let `--envelope` (in `teax`) append the standardized metadata footer (`<!-- envelope:v1 ... -->`).
> - For communicating with agents on the same local daemon, use native `paseo send` or MCP `send_agent_prompt`. `x_comms_*` is strictly for remote cross-daemon fleet hosts.

### Envelope Template

Actual comment text comes first. The agent envelope is appended as a clean, single-line footer rendered automatically when using `--envelope`:

```markdown
<Your actual comment / progress report / deliverable here>

---
<sub>🤖 **<AgentName/SessionTitle>** (`<ShortId>`) · `<Model>` · `<Repo>:<Branch>` · _<UTC Timestamp>_</sub>
```

### Environment Toolkit: `xpufx-tool`

`xpufx-tool` is the unified, parameterized CLI toolkit for agent and environment utilities:
- `xpufx-tool envelope`: Outputs the standardized markdown badge footer.
- `xpufx-tool envelope --format json`: Dumps full agent metadata as JSON.
- `xpufx-tool envelope --format kv`: Dumps key-value pairs for shell consumption.
- Supports override flags: `--agent-id`, `--agent-name`, `--model`, `--provider`, `--workspace`, `--branch`.

> [!IMPORTANT]
> **No Standalone Script Creation**: Never create loose, one-off standalone scripts in `~/bin` or repo directories. Any agent/environment helper utility must be implemented as a scoped, parameterized subcommand inside `xpufx-tool` (with proper `argparse` argv handling), or embedded directly into `teax` if Forgejo-specific.

> [!CAUTION]
> **Stamps are convention-only, unverified**: the envelope name is resolved best-effort (daemon snapshot title when reachable, else env / provider session DB). The daemon title, the provider session title, and transient retitles can disagree, and nothing records who set a title — so a stamp may disagree with what the Paseo UI shows. Never treat a stamp as proof of which agent acted (see `xpufx-org/paseo#83` for the canonical-title work and the still-missing upstream title provenance). If a stamp looks wrong, check `paseo ls` / `paseo inspect <id>` before assuming attribution.

---

## 5. Steering Labels & Operational Directives

Labels are how the Orchestrator communicates the **state, bounds, and steering signals** of **your assigned ticket**. They are not a queue for a worker to browse or self-dispatch from — read them only to understand the work you were handed.

- **Precedence Rule (Recent Updates Over Labels)**: On your assigned ticket, if there is a recent update (`updated_at` delta), **recent comments and feedback ALWAYS take precedence over static labels**. Never rely on a static label and move on without inspecting recent activity. **Read the 3 latest comments first** to understand the current state; if that context is inconclusive or references earlier requirements, read a few more comments backwards. If a human or peer agent posted new feedback or instructions after the last agent completion, that feedback governs your execution.
- **`flag/stop-work`**: Circuit breaker scoped strictly to this issue. If your assigned ticket carries it, stop immediately — do not commit or push further changes for it, and escalate.
- **`attention/2-user` (`user-attention`)**: Escalation signal for blocked or ambiguous assigned work. Used when the required deliverable (or next action) is fundamentally unclear.
  - **Strict Guardrail**: Agents may **never** use this label as an excuse to avoid work or offload solvable technical decisions.
  - **Mandatory Requirement**: Whenever applying it, the agent **MUST** post a clear, precise comment directly addressing the human user (`@oktay`) stating what options exist and what exact clarification or decision is required to unblock execution.
- **`upstream-check` / `check-upstream`**: Steering instruction on the assigned ticket. Before implementing custom logic or local workarounds, investigate upstream Paseo code, releases, PRs, issues, or discussions to see what Paseo already provides, plans to support, or how it implements the pattern natively.
- **`upstream`**: The assigned work is blocked directly on an upstream Paseo capability or bug fix. Stop and escalate rather than working around it.
- **`format/0-needed` / `format-issue`**: Clean up presentation, spelling, typos, broken markdown, code blocks, or formatting of the assigned ticket text without altering what it says or changing the author's meaning/intent.
- **`spec/*` (Pre-Code Steering Flow)**:
  - **Phase 1: Shape & Plan (`spec/1-checklist`)**: When the assigned ticket is in the shaping stage, the job is **strictly pre-code shaping**. Ingest human steering, update the ticket body with clear specifications, boundary constraints, and concrete `- [ ]` checklists. **Zero code or file modifications are permitted during this phase.**
  - **Phase 2: Human Approval (`spec/2-approved`)**: Implementation may **ONLY** begin after the human operator reviews the checklist and explicitly approves it (`spec/2-approved` / `green-light`).
- **`confirmed-done`**: Human operator confirms the final deliverable. Human says the last word with this; no other label except `SOS` has precedence. Agents may not reopen or modify an issue tagged `confirmed-done`.
- **`priority/0-SOS`**: Highest priority urgent dispatch. If dispatched to it, drop other work and handle it immediately.
- **`dep/blocked` / `blockee` / `blocker`**: Dependency indicators. Check linked blocking issues before proceeding with assigned work.
- **`attention/3-ignore` (`agent-ignore`)**: Hard silence directive. The Orchestrator suppresses triage for this ticket unless escalated with `SOS`; a worker takes no action on it.

### Scoped & Exclusive Labels (Forgejo Native Standard)
Defined in [`.forgejo/labels/agent-workflow.yaml`](file:///.forgejo/labels/agent-workflow.yaml). When scoped labels (`scope/name`) with `exclusive: true` are present, applying a new label in that scope automatically evicts any existing label sharing that scope prefix at the Forgejo DB level (zero `--remove-label` needed):
- **`format/` Scope**: `format/0-needed` ↔ `format/1-ok` (cleaning presentation and applying `format/1-ok` automatically clears `format/0-needed`).
- **`spec/` Scope**: `spec/0-needed` → `spec/1-checklist` → `spec/2-approved` (shaping phase transitions automatically clear previous stages).
- **`state/` Scope**: `state/0-triage` → `state/1-wip` → `state/2-review` → `state/3-verify` → `state/4-done` (execution lifecycle).
- **`attention/` Scope**: `attention/0-orchestrator` ↔ `attention/1-agent` ↔ `attention/2-user` ↔ `attention/3-ignore` (action token).
- **`priority/` Scope**: `priority/0-SOS` ↔ `priority/1-high` ↔ `priority/2-normal` ↔ `priority/3-low` ↔ `priority/4-backburner`.

---

## 6. Task Execution Lifecycle

### Step 1: Validate Launch Contract & Claim Assigned Work
1. **Require an assigned ticket and launch contract**: Your launch contract names exactly one ticket and one workspace. If either is absent, or the ticket/workspace does not match the contract, **stop immediately** and report/escalate to the Orchestrator. Never scan the board, rank candidates, or self-claim unassigned work.
2. **Mandatory Full Ticket & History Audit** (of the assigned ticket only):
   - **Read the entire ticket**: Never assume you know the scope from the title or prior memory. The issue body may have been rewritten, amended, or contain crucial boundary constraints.
   - **Read the ENTIRE comment thread**: Human operators frequently modify scope (e.g. *"SKIP step 2"*, *"Do not touch X"*, *"Focus only on Y"*), or another agent might have added crucial context or warnings. Blindly executing a plan without verifying the latest comment thread is a critical protocol violation.
3. If the assigned ticket has **`upstream-check`**, first audit upstream Paseo repositories/docs to inform your approach.
4. Check the assigned ticket's comments to verify no other agent has already claimed it; if it is already claimed, stop and escalate rather than duplicating work.
5. Post an Agent Envelope comment announcing your claim **on the assigned ticket**.
6. **Attach the `state/1-wip` label to the assigned ticket immediately** (e.g. `teax issue edit <number> --add-label state/1-wip`). Because `state/` is an exclusive scope, applying `state/1-wip` automatically clears any prior state like `state/0-triage` without needing removal flags.

### Step 2: Implementation Guidelines
- **Autonomous Execution on Assigned Work:**
  Work quietly in your designated worktree/checkout without spamming chat.

#### Mandatory: Silent Autonomous Execution Invariant
The worker runs **unattended** — nobody is watching its composer window, streaming turn, or intermediate output. The transcript is not a deliverable.

- **Zero narration into composer/chat channels**: no streaming prose, no "now I'll…", no step-by-step status, no inner monologue, no reasoning-out-loud, no restating the task or the ticket, no "let me check the tests first" chatter. Reasoning stays internal.
- **One surface for progress, and it is the board**: progress and findings belong on the issue/PR timeline as stamped envelope comments, budgeted per the Comment Budget rule above. Chat carries nothing but the brief token-economy pointer to the ticket.
- **Silence covers the whole run, not just the ending**: no "starting now" opener, no mid-run check-ins, no celebrating a passing test suite, no asking permission for a routine step you were already authorized to take.
- **Exceptions — speak only when they change someone else's next action**:
  - a blocker that needs an Orchestrator decision (goes to the parent callback, Step 3.7, and `attention/2-user` on the ticket);
  - a completion signal to the parent (Step 3.7);
  - a direct interactive message from the human operator, answered in one line.
- Emitting narration is a protocol violation even when the work is correct. A silent worker with a green PR is the success case.

#### Mandatory: Paseo Plugin Helper UI Standards (Never Bespoke Raw React Native)
When building or modifying client UI in Paseo plugins:
1. **Reference Gold Standard**: Inspect `plugins/mcp-tools` as the canonical reference implementation. It adheres to all `paseo-plugin-helper` UI patterns.
2. **Never Handroll Bespoke UI Primitives**:
   - **Do NOT hardcode modal dimensions**: Never set `minWidth: 460`, `minHeight`, or fixed widths on `<ModalBody>` or modal containers. Modals must be 100% fluid and adapt to whatever dialog width Paseo allocates.
   - **Do NOT roll custom buttons or selectors using `<Pressable>`**: Use `Button`, `Tabs`, or `FormRow` containing `Button` variants (`variant="primary" | "ghost" | "secondary"`).
   - **Do NOT roll custom form rows or setting switches**: Use `<FormRow label="..." description="...">` wrapping `<Toggle>` or `<TextInput>`.
   - **Do NOT roll custom card borders or headers**: Use `<Card variant="elevated">`, `<Card.Header title="..." subtitle="..." />`, or `<SectionHeader>`.
   - **Do NOT roll custom key/value displays**: Use `<KeyValueGroup>` and `<KeyValue>` (or `CompactKeyValue`).
   - **Do NOT roll custom empty or status indicators**: Use `<EmptyState>` and `<StatusDot>`.
3. **Available Helper Client Palette**: Exported from `paseo-plugin-helper/client`:
   - **Layout**: `ModalBody`, `ActionBar`, `FormRow`
   - **Components**: `Card`, `Tabs`, `Button`, `Toggle`, `TextInput`, `Badge`, `StatusDot`, `KeyValue`, `KeyValueGroup`, `Collapsible`, `SectionHeader`, `CommandBox`, `AttentionBeacon`, `CodeBlock`, `SearchInput`, `EmptyState`, `ProgressBar`, `MetricGauge`, `DataTable`, `TruncatedText`, `AboutSection`, `Icon`
4. **Audit Before Delivery**:
   - Run `./packages/paseo-plugin-helper/bin/paseo-plugin-helper.js audit <plugin-path>` to catch anti-patterns.

- **Verification:** Run typechecks (`npm run typecheck`), linters, and test suites locally before claiming completion.

### Step 3: Handoff to `Orchestrator` (`state/2-review` via Pull Request)
When code is implemented and verified locally in your worktree:
1. **Push the assigned workspace branch to `origin`**:
   ```bash
   git push origin HEAD
   ```
2. **Open a Pull Request**:
   Use `teax pr create` targeting `main`, and immediately post a stamped comment on the PR for GUI auditability:
   ```bash
   teax pr create -t "<type>(<scope>): <title> (#<issue#>)" -b "Refs #<issue#>\n\n### Summary\n- <concise summary of changes>\n\n### Verification\n- Tests/checks passed: <command/details>" -B main -H <branch-name>
   teax issue comment <pr#> -R <repo> --hostname forge.mrs.uppidi.com --envelope -b "### PR Opened\nRefs #<issue#>\n- Branch: \`<branch-name>\`\n- Summary: <concise summary of changes>"
   ```
3. **Mandatory Live Freshness Sync (Plugin Repositories)**: Run `npm run doctor:live -- --reload`.
   - Ensures `packages/paseo-plugin-helper/dist` is compiled and in sync.
   - Automatically stamps the latest commit into `shared/version.ts`.
   - Reloads the live Paseo daemon for your plugin (`paseo plugin reload <id>`).
   - Verifies the daemon is actively running your latest commit before requesting review.
4. **Post completion comment with your Agent Envelope** (`teax issue comment <number> --envelope -b ...`):
   - **Strict Formatting Standard**: Never dump an unformatted, narrative wall of text. Use clean GitHub-flavored markdown with structured headers (`### Implementation Summary`), bulleted deliverables, explicit code host/repo/branch/SHA, PR link, and test results.
   - Summary of changes implemented.
   - Updated checklist showing completed items.
   - Branch name, commit hash(es), and **clickable Pull Request link**.
   - Confirmation that typechecks and tests passed.
   - **Deployment & Verification Status block** (if plugin):
     ```markdown
     ### 🚀 Deployment & Verification Status
     - **Pull Request**: `<pr-url>`
     - **Commit**: `<sha>` on `origin/<branch>`
     - **Live Doctor**: Passed (`npm run doctor:live`)
     - **Daemon Status**: Reloaded (`paseo plugin reload <id>`)
     - **Client Action**: Re-open the modal/surface (or press Ctrl+R / Cmd+R in Paseo if window is open).
     ```
5. **Transition the state to `state/2-review`**: Apply **`state/2-review`** and `review/0-needed`.
   - Command: `teax issue edit <number> --add-label state/2-review --add-label review/0-needed`
   - **Automatic Eviction**: Because `state/` and `review/` are exclusive scopes, this clears prior states automatically.
   - **Operator/Orchestrator verdict**: `review/2-approved` means advance to `state/3-verify` (or merge PR); `review/1-changes-requested` means return to `state/1-wip`.

   > [!CAUTION]
   > **MANDATORY LABEL UPDATE**: You MUST execute `teax issue edit <number> --add-label ...`. Merely posting an envelope comment without executing the label update command leaves the issue stranded in its old state on the board.

6. **Do NOT close the issue, merge the PR, or archive the workspace**: Leaf workers do not merge PRs, close issues, or perform workspace/branch cleanup. The PR is merged by the Repo Orchestrator after pre-flight audit, transitioned to `state/3-verify` with `attention/2-user`, and archived. Autonomous actors never close issues — issue closure is strictly reserved for the human operator. Operator escalation is strictly via `attention/1-user`.
7. **Notify the parent Orchestrator (MANDATORY)**: The board handoff above is the durable record; this callback is the immediate signal so the Orchestrator does not sit polling a ticket. On completion **or** on any blocker, message the parent explicitly:
   ```bash
   paseo send --steer --no-wait <parentAgentId> "Worker #<issue#> completed: PR <url>, tests pass."
   ```
   - `--steer` is **mandatory**: without it the default `activeTurnBehavior` is `interrupt`, which clobbers the parent's active turn mid-work (see `skills/orchestrator/SKILL.md` §13 for the same footgun on the Front Desk escalation path).
   - `<parentAgentId>` comes from the Orchestrator's launch contract; if it was not supplied, treat that as a contract gap and escalate on the ticket instead of staying silent.
   - **This supplements the board handoff, it never replaces it**: still post the envelope comment, still apply `state/2-review` + `review/0-needed`. The callback is a ping, the board is the record.
   - Keep it to one line. Do not paste diffs, logs, or per-step narration into the parent message.
8. Stand by for review from the `Orchestrator` or testing by the operator.
