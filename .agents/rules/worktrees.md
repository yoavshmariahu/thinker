# Rule: Always Use Git Worktrees for Agent Tasks

## Context
Multiple coding agents and automated benchmark harnesses run concurrently in this repository. Making edits or running tests directly in the primary working tree causes file conflicts, polluted benchmark runs, and race conditions.

## Requirements
1. **Never edit directly in the primary working tree**:
   - Before making any code changes, creating scratch files, or running benchmarks, create an isolated worktree.
2. **Worktree locations**:
   - Use `.worktrees/<task-or-agent-name>` or `bench/worktrees/<task-or-agent-name>` (both are gitignored).
   - Example:
     ```bash
     git worktree add -b agent/<task-name> .worktrees/<task-name> HEAD
     ```
3. **Work within the worktree**:
   - Direct all edits, commands, and tests to the worktree path.
4. **Always destroy the worktree on completion**:
   - When the work is done (e.g., changes committed/pushed/merged) or if the task is cancelled or aborted:
     ```bash
     git worktree remove --force <worktree-path>
     git branch -D agent/<task-name> # if merged or abandoned
     ```
   - Never leave stale worktrees behind.
