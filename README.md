# GitLab MCP Server

Stop copy-pasting GitLab tickets, merge requests, and repository snippets into your AI chat.

This project exposes GitLab as an [MCP](https://modelcontextprotocol.io) server so an agent can work directly against your GitLab organization: select projects, read issues and merge requests, inspect pipelines, open repository files, and write back audited updates.

The result is simple:

- Your agent works on live GitLab data instead of pasted context.
- You can move across repositories in the organization from the same conversation.
- Comments and issue descriptions written by the agent are marked for audit.
- The control surface lives in tools, not in ad-hoc copy/paste.

All access is still constrained by the GitLab user and token you provide. This server does not bypass GitLab permissions.

---

## Why this is useful

Without an MCP server, a typical workflow looks like this:

1. Open GitLab.
2. Copy a ticket into the chat.
3. Copy comments or MR diffs into the chat.
4. Ask the agent to reason about stale pasted data.
5. Go back to GitLab and manually apply the result.

With this server, the agent can do the work against GitLab directly:

- Find the right project in the organization.
- Read the current issue, comments, MR, pipeline, branch, or file state.
- Propose or apply updates.
- Leave auditable AI-generated comments and descriptions.

---

## What your agent can do today

### Project discovery and navigation

- Search the projects available to the authenticated user.
- Read a live project catalog resource at `gitlab://projects/catalog` to map natural repository names to full GitLab paths.
- Resolve repository names like `group-name/project-name`, natural forms like `group-name project-name`, short names like `project-name`, or full GitLab URLs on the configured host when unambiguous.
- List the exact labels available in a project before using them in issue filters.
- Retry issue lookups across matching project candidates when a natural project hint resolves to the wrong repository on the first pass.
- Keep an active project in the current MCP session so follow-up requests can stay natural.

### Issue workflows

- List labels in the current project to discover the exact status or workflow names in use.
- List issues by state, assignee, and project labels, with case-insensitive exact matching like `bug` -> `Bug` and unique shorthands like `blocked` -> `Status Blocked`.
- Read a full issue or ticket, including its **Work Item Status** (e.g. `In Dev Review`, `Ready for QA`) when the project uses GitLab's Work Items feature.
- Read the Work Item Status of a specific issue directly, without fetching all issue details.
- Read issue comments in chronological order.
- Create issues.
- Add issue comments.
- Update issue fields like title, description, labels, assignees, due date, weight, and state.

### Merge request workflows

- List merge requests by state and assignee.
- Read the full diff of an MR.
- Read MR comments.
- Add MR comments.

### CI and repository workflows

- List recent pipelines.
- Inspect jobs in a pipeline.
- Read repository files from a specific ref.
- List branches and search by branch name.

---

## What this enables in practice

Examples of real agent workflows you can run with the current tools:

- Triage a ticket, read its history, and leave a proposed next-step comment.
- Switch from one product repo to another in the same organization without changing tools.
- Review an MR by reading the live diff and existing discussion.
- Investigate a failing pipeline by reading recent runs and jobs.
- Pull a remote file from the repo to give the agent code context before answering.
- Update issue metadata after analysis, for example labels, due date, assignees, or close/reopen state.

Example prompts:

- `Select the Payments project`
- `List labels in the current repository`
- `Show me ticket 128`
- `Summarize the ticket comments and propose next steps`
- `Add a comment with the action plan`
- `List open merge requests`
- `Open the diff for MR 42`
- `Show me the latest pipeline for main`
- `Read src/index.ts from the current repository`
- `Switch to the group-name/another-project project`

---

## Exposed tools

### Resources

| Resource | Purpose |
|---|---|
| `gitlab://projects/catalog` | Live catalog of accessible GitLab projects, intended to help the agent resolve repository references before calling tools |

### Project and session tools

| Tool | Purpose |
|---|---|
| `select_project` | Resolve and store the active project for the current MCP session |
| `clear_active_project` | Clear the active project stored in the current MCP session |
| `list_projects` | Search projects available to the authenticated user, optionally scoped to a specific group |
| `list_labels` | List the exact labels available in the active project, optionally filtered by name |

### Issue tools

| Tool | Purpose |
|---|---|
| `list_issues` | List issues by state, assignee, and resolved project labels such as `bug` -> `Bug` or `blocked` -> `Status Blocked` |
| `get_issue` | Read a full issue or ticket by IID, including Work Item Status when available |
| `list_work_item_statuses` | List all work items with their Work Item Status in a single GraphQL call — useful for a full project status overview |
| `get_issue_status` | Read the Work Item Status of a specific issue (e.g. `In Dev Review`, `Ready for QA`) via GraphQL |
| `get_issue_comments` | Read issue comments in chronological order |
| `create_issue` | Create a new issue |
| `add_issue_comment` | Add an audited comment to an issue |
| `update_issue` | Update issue fields and state, with audited descriptions when written by the agent |

### Merge request tools

| Tool | Purpose |
|---|---|
| `list_merge_requests` | List merge requests by state and assignee |
| `get_merge_request_diff` | Read the full MR diff |
| `get_merge_request_comments` | Read MR discussion comments |
| `add_merge_request_comment` | Add an audited comment to an MR |

### CI tools

| Tool | Purpose |
|---|---|
| `list_pipelines` | List recent pipelines, optionally filtered by status or ref |
| `get_pipeline_jobs` | Read jobs for a specific pipeline |

### Repository tools

| Tool | Purpose |
|---|---|
| `get_file_contents` | Read a repository file at a specific branch, tag, or commit |
| `list_branches` | List branches and search by name |

---

## Active project model

The server does not assume a default active project.

Instead:

- The agent can call `select_project` once and keep working naturally afterwards.
- The agent can call `clear_active_project` to drop stale repository context from the current MCP session.
- Any tool can also receive a `project` argument directly.
- When a `project` is passed, it becomes the active project for the current MCP session.
- If a project is omitted later, the server uses the active project from the session.
- To switch repositories inside the same session, either call `select_project` with the new repository or pass `project` explicitly on the next tool call.

Project values can be:

- A numeric GitLab project ID
- A full namespace/path like `group-name/project-name`
- A natural namespace-and-name form like `group-name project-name`
- A short project name like `project-name`
- A full GitLab project, issue, or merge request URL on the configured host

Short names and natural forms are resolved across the projects accessible to the authenticated user. The server also exposes `gitlab://projects/catalog` so the agent can inspect the available repositories before selecting one. If the name is ambiguous, use the full namespace/path.

If multiple projects match, the server returns an ambiguity message and asks for the full namespace/path.

The active project is stored in the running MCP server process. If your client keeps that process alive across multiple chat threads, the active project can outlive a single conversation. When the user switches repositories, prefer passing `project` explicitly or call `select_project` / `clear_active_project` before continuing.

---

## AI audit trail

Any text written by this MCP to GitLab is automatically prefixed with an audit header when applicable.

This currently applies to:

- Merge request comments
- Issue comments
- Issue descriptions on create
- Issue descriptions on update

The audit header includes:

- A stable audit marker
- An explicit `AI-generated content` notice
- The model name when available
- The MCP client name/version
- A UTC timestamp

Example:

```md
<!-- gitlab-mcp-ai-audit -->
> AI-generated content
> Model: unknown (MCP client did not expose model)
> Client: Claude Desktop 0.10.0
> Generated by: gitlab-mcp MCP server
> Generated at: 2026-04-29T12:34:56.000Z
```

How the model name is resolved:

- If `GITLAB_AUDIT_MODEL` is set, it is used as an explicit override.
- Otherwise, the server looks for custom MCP metadata in `gitlab-mcp/model`.
- If the MCP client does not expose model information, the header falls back to `unknown (MCP client did not expose model)`.

The server can reliably detect the MCP client identity from the MCP initialization handshake. It cannot reliably infer the underlying LLM model unless the client sends it.

---

## Requirements

- Node.js 18+
- A GitLab Personal Access Token with `api` scope
- Access to the GitLab group/projects you want the agent to work with

GitLab docs:

- [Personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)
- [GitLab REST API](https://docs.gitlab.com/api/)

---

## Configuration

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITLAB_TOKEN` | ✅ | — | GitLab Personal Access Token with `api` scope |
| `GITLAB_AUDIT_MODEL` | ❌ | Auto-detected when possible, otherwise `unknown` | Optional override for the model name written into AI audit headers |
| `GITLAB_BASE_URL` | ❌ | `https://gitlab.com` | Base URL of your GitLab instance. For self-hosted GitLab, use your instance root URL, for example `https://gitlab.example.com` |

Example `.env`:

```env
GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
GITLAB_BASE_URL=https://gitlab.example.com
```

Where to get the values:

- `GITLAB_TOKEN`: GitLab → User settings → Access tokens → create a token with `api` scope
- `GITLAB_BASE_URL`: only needed for self-hosted GitLab. Use the root URL of your GitLab instance, for example `https://gitlab.example.com`

---

## Build and run

```bash
npm install
npm run build
GITLAB_TOKEN=glpat-xxx node dist/index.js
```

Or with a `.env` file:

```bash
npx dotenv -e .env -- node dist/index.js
```

For local development without compiling:

```bash
npx ts-node src/index.ts
```

For normal MCP usage with Claude Desktop, Claude Code, or Codex, you do not need to keep this server running manually. The MCP client starts the command on demand whenever the agent needs it.

---

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/absolute/path/to/gitlab-mcp/dist/index.js"],
      "env": {
        "GITLAB_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx",
        "GITLAB_BASE_URL": "https://gitlab.example.com"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

Claude Desktop launches the MCP server command when needed. You do not need to keep a separate long-running process alive.

---

## Claude Code

Create or edit `mcp.json` in your project root, or `~/.claude/mcp.json` globally:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/absolute/path/to/gitlab-mcp/dist/index.js"],
      "env": {
        "GITLAB_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx",
        "GITLAB_BASE_URL": "https://gitlab.example.com"
      }
    }
  }
}
```

Then run:

```bash
claude mcp list
```

Claude Code launches the MCP server command when needed. You do not need to keep a separate long-running process alive.

---

## Codex

You can configure this server in Codex either from the built-in MCP server UI or with Codex CLI.

From Codex itself, open `Settings` -> `MCP servers` -> `Connect to a custom MCP`, keep `STDIO` selected, and use:

- Name: `gitlab`
- Command to launch: `node`
- Arguments: `/absolute/path/to/gitlab-mcp/dist/index.js`
- Environment variables: add `GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx`
- Environment variables: optionally add `GITLAB_BASE_URL=https://gitlab.example.com` for self-hosted GitLab

Example Codex MCP server configuration:

![Codex MCP server settings](./settings.png)

If you prefer the CLI, make sure Codex CLI is installed globally and the `codex` command is available in your shell `PATH`, then add the server with:

```bash
codex mcp add gitlab \
  --env GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx \
  --env GITLAB_BASE_URL=https://gitlab.example.com \
  -- node /absolute/path/to/gitlab-mcp/dist/index.js
```

Then verify it:

```bash
codex mcp list
codex mcp get gitlab
```

If you need to update the command or environment variables later, remove and re-add it:

```bash
codex mcp remove gitlab
```

Codex launches the MCP server command when needed. You do not need to keep a separate long-running process alive.

---

## Notes

- The server targets the GitLab REST API v4 for most operations, and the GitLab GraphQL API for Work Item Status.
- All list-style tools default to `per_page=20` and support up to `100` where GitLab allows it.
- `get_issue`, `get_issue_status`, and `get_issue_comments` accept `iid`, `issue`, or `ticket` as the issue identifier.
- Invalid project-selection errors are returned as tool text so the agent can recover more gracefully.
- GitLab API permission errors are also surfaced back as tool text rather than opaque failures.
- `list_projects` can still be scoped explicitly with a `group` argument when the user wants to narrow discovery to a specific organization or subgroup.
- System notes are filtered out from issue and MR comment reads; only user-authored comments are returned.
- File contents returned by `get_file_contents` are automatically base64-decoded.

### Work Item Status

The **Status** field (e.g. `In Dev Review`, `Ready for QA`) is part of GitLab's new Work Items system and is not exposed by the REST API. This server fetches it via the GitLab GraphQL Work Items API.

`get_issue` fetches the Work Item Status automatically in the background and includes it in the response when available. `get_issue_status` provides a dedicated tool to query only the status of a single issue. `list_work_item_statuses` retrieves all work items in a project with their statuses in a single GraphQL call — useful for a full status overview.

If a project does not have the Work Items feature or the Status widget enabled, the status field will be absent from `get_issue`, and `get_issue_status` and `set_work_item_status` will return a descriptive message instead of failing.

---

## What this is not

- It is not a GitLab permission bypass.
- It is not a full Git client replacement.
- It does not yet expose every GitLab API surface.

It is a focused MCP control plane for letting an agent work directly with GitLab instead of through pasted screenshots, copied tickets, and manual relay.
