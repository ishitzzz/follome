# Architecture & Continuity

## Memory & Continuity System
Context continuity across sessions and model switches is maintained via `docs/state.json` and append-only logs.
1. **Initialization:** A newly instantiated agent ALWAYS reads `docs/state.json` first.
2. **State Resolution:** `state.json` identifies the `current_phase` and `current_task_id`.
3. **Targeted Reading:** The agent reads only the relevant task block from `docs/tasks.json` and the specified files.
4. **State Commit:** After a task is verified and completes, the agent updates `docs/state.json` and marks the task `"COMPLETED"` in `docs/tasks.json`.

## Token Efficiency Strategy
To minimize token usage while preserving clarity:
- **What is Passed:** The `state.json`, the specific task object from `tasks.json`, and any immediately relevant source file paths.
- **What is NOT Passed:** Completed phases, future tasks out of scope, or full architectural histories. 
- **Formatting:** JSON is used for structurally dense data (`tasks`, `state`). Markdown is used for human/agent readable summaries, kept strictly to bullet points.

## Skill Standardization (Execution Logic)
Shared execution logic ensures all agents behave consistently without duplicating logic. No divergence is permitted.

- **DOM Mapping & Extraction:** Standardize on specific selectors and extraction functions. All agents must use the predefined matching logic without modification. Elements are scored rather than selected via crude querySelector strings.
- **Step Execution:** Use predefined action sequences. For example, triggering a click involves highlighting the element and simulating a user click. Agents do not invent new pathways.
- **Error Recovery:** If an element is missing, agents do NOT guess multiple variants within the target code. They log a failure in `failures.md`, pause execution, and update `state.json` to `status: "BLOCKED"`.
