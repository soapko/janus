# Global Development Framework

Development standards across all projects. Detailed workflows are in global skills at `~/.claude/skills/`.

---

## Critical Rules

### Rule #1: NEVER Claim Success Without Testing

**FORBIDDEN** words before verified testing: "successfully", "working", "complete", "functional"

- Code must be executed, produce expected output, and complete without errors
- Use `dev-testing` skill for verification workflow

### Rule #2: NEVER Implement Without a Task Document

```
Request -> Does docs/tasks/task-XXX.md exist?
              |
         NO: Use dev-research to create task doc FIRST
         YES: Proceed with implementation
```

- Every todo in Todos.md must reference a task document
- If task doc missing, deploy research agent before any implementation

### Rule #3: Todos.md is Source of Truth

- Read Todos.md at every session start
- Update Todos.md at every session end
- Archive completed task docs to `docs/tasks/archive/`
- Use `dev-task-management` skill for full workflow

### Rule #4: Systematic Troubleshooting

- Trace full code path before implementing any fix
- Never stop at first suspicious line
- Test fix before claiming bug resolved
- Use `dev-troubleshooting` skill for full process

---

## Skill Routing

| Trigger | Skill |
|---------|-------|
| Session start, "read todos", tracking progress | `dev-task-management` |
| "Research X", task doc doesn't exist | `dev-research` |
| Complex feature, parallel work, delegation | `dev-orchestration` |
| Building features, writing code | `dev-implementation` |
| "Is it working?", before claiming done | `dev-testing` |
| Bugs, errors, "why isn't X working?" | `dev-troubleshooting` |

---

## Quick Reference

**Session Start:** Read Todos.md -> Verify task docs exist -> Read task doc

**Before Implementation:** No task doc? -> `dev-research` first

**After Implementation:** Test and verify -> Update Todos.md -> Archive task doc
