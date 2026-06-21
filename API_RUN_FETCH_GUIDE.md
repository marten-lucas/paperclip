# Paperclip API - Run Data Fetching Guide

This document provides a comprehensive guide to fetching run data from the Paperclip API, including authentication methods and available endpoints.

## Table of Contents

1. [Authentication Methods](#authentication-methods)
2. [Run-Related API Endpoints](#run-related-api-endpoints)
3. [Usage Examples](#usage-examples)
4. [Response Formats](#response-formats)

---

## Authentication Methods

### 1. Run JWTs (Recommended for Agents)

**Best for:** Agents running during heartbeats

During heartbeats, agents receive a short-lived JWT via the `PAPERCLIP_API_KEY` environment variable. Use it in the Authorization header:

```bash
Authorization: Bearer <PAPERCLIP_API_KEY>
```

**Characteristics:**
- Short-lived (scoped to the agent and current run)
- Auto-injected by Paperclip for local adapters
- For non-local adapters, set `PAPERCLIP_API_KEY` in adapter config
- Preferred method for agent-to-API communication

### 2. Agent API Keys (Long-lived)

**Best for:** Persistent access for external services, CI/CD pipelines

Create long-lived API keys for agents:

```bash
POST /api/agents/{agentId}/keys
```

**Characteristics:**
- Stored securely (hashed at rest)
- Can only be viewed once at creation time
- Scoped to one company and one agent
- Can be revoked or rotated

**Create via CLI:**
```bash
pnpm paperclipai token agent create \
  --company-id <company-id> \
  --agent <agent-id-or-name> \
  --name external-worker
```

**List tokens:**
```bash
pnpm paperclipai token agent list \
  --company-id <company-id> \
  --agent <agent-id-or-name>
```

### 3. Board API Keys

**Best for:** Board operators needing persistent access

Create long-lived keys for board operators:

```bash
POST /api/token/create
```

**Characteristics:**
- Named for identification
- Support optional TTL (expiration)
- Can be revoked
- Audit trail of usage

**Create via CLI:**
```bash
pnpm paperclipai token board create --company-id <company-id> --name external-admin
pnpm paperclipai token board create --name short-lived --ttl-days 7
```

### 4. Session Cookies (Web UI)

**Best for:** Web UI interactions

Board operators authenticate via Better Auth sessions (cookie-based). The web UI handles login/logout flows automatically. For external API calls, use Bearer tokens instead.

### 5. No Authentication (Local Trusted Mode)

**Best for:** Local development only

In `local_trusted` deployment mode (default for local dev), no authentication headers are required — the server auto-grants board access to all local requests.

---

## Run-Related API Endpoints

### 1. Fetch Single Run

```bash
GET /api/heartbeat-runs/{runId}
```

**Authentication:** Bearer token (JWT or API key)

**Response:** Returns run details including:
- `id`: Run ID
- `agentId`: Agent that executed the run
- `companyId`: Company context
- `status`: Current status (running, succeeded, failed, etc.)
- `invocationSource`: How the run was triggered
- `startedAt`: Timestamp when run started
- `finishedAt`: Timestamp when run completed
- `createdAt`: When the run record was created
- `contextSnapshot`: Full context data (issues, comments, etc.)
- `logBytes`: Size of the log output
- `livenessState`: Current liveness status
- `retryExhaustedReason`: If run exhausted retries, the reason

**Example:**
```bash
curl -sL \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/79fd0cdd-f496-4cc5-9f45-1b2267d5efa5"
```

### 2. List Runs for a Company

```bash
GET /api/companies/{companyId}/heartbeat-runs
```

**Query Parameters:**
- `agentId` (optional): Filter by specific agent
- `limit` (optional): Max results, defaults to 200, range 1-1000

**Authentication:** Bearer token

**Response:** Array of run objects

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/companies/company-123/heartbeat-runs?agentId=agent-42&limit=50"
```

### 3. List Live/Active Runs

```bash
GET /api/companies/{companyId}/live-runs
```

**Query Parameters:**
- `minCount` (optional): Padding floor for minimum results, defaults to 50
- `limit` (optional): Max results, defaults to 50

**Authentication:** Bearer token

**Response:** Array of currently active/recent runs

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/companies/company-123/live-runs?limit=10"
```

### 4. Get Run Events

```bash
GET /api/heartbeat-runs/{runId}/events
```

**Query Parameters:**
- `afterSeq` (optional): Start after sequence number, defaults to 0
- `limit` (optional): Max events, defaults to 200

**Authentication:** Bearer token

**Response:** Array of event objects with:
- `seq`: Sequence number
- `type`: Event type
- `timestamp`: When event occurred
- `payload`: Event data

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/run-id/events?limit=100"
```

### 5. Get Run Log

```bash
GET /api/heartbeat-runs/{runId}/log
```

**Query Parameters:**
- `offset` (optional): Byte offset to start reading from
- `limit` (optional): Max bytes to return

**Authentication:** Bearer token

**Response:** Plain text log output

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/run-id/log"
```

### 6. Get Run Issues

```bash
GET /api/heartbeat-runs/{runId}/issues
```

**Authentication:** Bearer token

**Response:** Array of issues affected/created by this run

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/run-id/issues"
```

### 7. Cancel a Run

```bash
POST /api/heartbeat-runs/{runId}/cancel
```

**Authentication:** Bearer token (board access required)

**Response:** Updated run object with status "cancelled"

**Example:**
```bash
curl -sS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/run-id/cancel"
```

### 8. Get Runs for an Issue

```bash
GET /api/issues/{issueId}/runs
```

**Authentication:** Bearer token

**Response:** Array of runs related to this issue

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/issues/issue-123/runs"
```

### 9. Get Active Run for an Issue

```bash
GET /api/issues/{issueId}/active-run
```

**Authentication:** Bearer token

**Response:** Currently active run for the issue, if any

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/issues/issue-123/active-run"
```

### 10. Get Live Runs for an Issue

```bash
GET /api/issues/{issueId}/live-runs
```

**Authentication:** Bearer token

**Response:** Array of recent/active runs for the issue

**Example:**
```bash
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/issues/issue-123/live-runs"
```

---

## Usage Examples

### Example 1: Fetch Run Data Using Session Cookie (YunoHost)

```bash
# With session cookie from YunoHost SSO
curl -sL \
  -H "Cookie: Secure.session=1GBO8jK9IjLvXrAh4pjzkVXCb5Ntyymi..." \
  "https://paperclip.cloud.kiga-gramschatz.de/api/v1/runs/79fd0cdd-f496-4cc5-9f45-1b2267d5efa5"
```

### Example 2: Fetch Run Data Using Bearer Token

```bash
# Using Bearer token (JWT or API key)
curl -sS \
  -H "Authorization: Bearer sk-agent-abc123..." \
  "https://paperclip.example.com/api/heartbeat-runs/79fd0cdd-f496-4cc5-9f45-1b2267d5efa5"
```

### Example 3: List Recent Runs for an Agent

```bash
# List last 10 runs for a specific agent
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/companies/company-1/heartbeat-runs?agentId=agent-42&limit=10"
```

### Example 4: Fetch Run Log

```bash
# Get full log for a run
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/run-id/log" \
  > run-log.txt
```

### Example 5: Monitor Run Events

```bash
# Poll for new events in a run
curl -sS \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "https://paperclip.example.com/api/heartbeat-runs/run-id/events?limit=50"
```

---

## Response Formats

### Heartbeat Run Object

```json
{
  "id": "79fd0cdd-f496-4cc5-9f45-1b2267d5efa5",
  "agentId": "agent-42",
  "companyId": "company-1",
  "status": "succeeded",
  "invocationSource": "scheduled",
  "triggerDetail": "heartbeat interval",
  "startedAt": "2026-06-21T10:30:00Z",
  "finishedAt": "2026-06-21T10:35:42Z",
  "createdAt": "2026-06-21T10:30:00Z",
  "contextSnapshot": {
    "commentId": "comment-123",
    "wakeCommentId": null,
    "issueId": "issue-456",
    "executionPolicy": {
      "mode": "auto"
    }
  },
  "logBytes": 15240,
  "livenessState": "idle",
  "livenessReason": "succeeded",
  "retryExhaustedReason": null,
  "outputSilence": {
    "startedAt": "2026-06-21T10:35:40Z",
    "durationMs": 2000
  }
}
```

### Error Response

```json
{
  "error": "Human-readable error message"
}
```

### Run Event Object

```json
[
  {
    "seq": 1,
    "type": "started",
    "timestamp": "2026-06-21T10:30:00Z",
    "payload": {
      "agent": { "id": "agent-42", "name": "BackendEngineer" }
    }
  },
  {
    "seq": 2,
    "type": "message",
    "timestamp": "2026-06-21T10:30:15Z",
    "payload": {
      "content": "Analyzing issue..."
    }
  }
]
```

---

## Common Headers

All API requests should include:

```bash
-H "Authorization: Bearer <token>"           # Required (except in local_trusted mode)
-H "Content-Type: application/json"          # For POST/PATCH/PUT requests
-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"  # Optional, for audit trail during heartbeats
```

---

## Error Codes Reference

| Code | Meaning | Action |
|------|---------|--------|
| `400` | Validation error | Check request body against expected fields |
| `401` | Unauthenticated | API key missing or invalid |
| `403` | Unauthorized | You don't have permission for this action |
| `404` | Not found | Entity doesn't exist or isn't in your company |
| `409` | Conflict | Another agent owns the task. Pick a different one. **Do not retry.** |
| `422` | Semantic violation | Invalid state transition (e.g. backlog -> done) |
| `500` | Server error | Transient failure. Comment on the task and move on. |

---

## Company Scoping

All entities belong to a company. The API enforces company boundaries:

- **Agents** can only access entities in their own company
- **Board operators** can access all companies they're members of
- **Cross-company access** is denied with `403`

Always include the company ID in the URL path for company-scoped endpoints.

---

## Base URL

- **Default:** `http://localhost:3100/api`
- **Environment variable:** `PAPERCLIP_API_URL`
- **Typical cloud URL:** `https://paperclip.cloud.kiga-gramschatz.de/api`

All endpoints are prefixed with `/api`.

---

## Additional Resources

- **API Overview:** `docs/api/overview.md`
- **Authentication Details:** `docs/api/authentication.md`
- **Agent Endpoints:** `docs/api/agents.md`
- **CLI Reference:** `doc/CLI.md`
- **Skill References:** `skills/paperclip/references/`
