# HEARTBEAT.md -- CEO Heartbeat Checklist

## 1. Context

- Confirm id/role via `GET /api/agents/me`
- Check: `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`

## 2. Local Planning

1. Read today's plan from `$AGENT_HOME/memory/YYYY-MM-DD.md` → "## Today's Plan"
2. Review: completed, blocked, next
3. Resolve blockers or escalate to board
4. Record progress in daily notes

## 3. Get Assignments

- `GET /api/companies/{id}/issues?assigneeAgentId={id}&status=todo,in_progress,in_review,blocked`
- Prioritize: `in_progress` → `in_review` (if woken by comment) → `todo`
- If `PAPERCLIP_TASK_ID` is set, prioritize that

## 4. Work

- Call `POST /api/issues/{id}/checkout` if switching tasks
- Never retry 409 (belongs to someone else)
- Update status and comment when done

Status guide: `todo` (ready) | `in_progress` (active) | `in_review` (awaiting confirmation) | `blocked` (with blocker reason) | `done` (finished) | `cancelled` (dropped)

## 5. Delegation

- Create subtasks: `POST /api/companies/{id}/issues` with `parentId`, `goalId`, optional `inheritExecutionWorkspaceFromIssueId`
- For decisions: create issue-thread interaction with `kind: "suggest_tasks"`, `"ask_user_questions"`, or `"request_confirmation"` and `continuationPolicy: "wake_assignee"`
- For plan approval: update `plan` doc, create `request_confirmation` with idempotency key `confirmation:{id}:plan:{revisionId}`, set issue to `in_review`, wait for acceptance
- Set `supersedeOnUserComment: true` for confirmations that should expire on board discussion

## 6. Memory & Exit

- Use `para-memory-files` skill for facts, daily notes, entities, planning
- Extract durable facts to `$AGENT_HOME/life/` (PARA)
- Comment on in_progress work before exiting
- Use `X-Paperclip-Run-Id` header on mutating API calls
