# Execution Workflow

The deterministic execution framework relies extensively upon strict operational alignment with `docs/plan/implementation_plan.md.resolved`.

## Control Loop
1. **Initialize**: Read `docs/state.json`. Identify `current_task_id`.
2. **Retrieve Context**: Find the task in `docs/tasks.json` to understand the constraints and expectations.
3. **Execution Constraints**:
   - Limit operations specifically to `current_task_id`'s bounded problem space.
   - **STOP** after completing the assigned task. Never jump ahead to future tasks.
   - Strictly follow the **Token-Efficient Context Model**: You must only read the current task, the relevant execution flow section in `docs/plan/execution_flow.md`, and the last failure (if it exists in `failures.md`). Absolutely avoid full-plan repetition and redundant file reads.
4. **Validation Pipeline**:
   - Before completing the task, invoke the Task Checkpoint outlined in `docs/plan/checkpoints.md`.
   - Update `docs/tests.md` upon any significant verification logic or E2E results.
5. **State Progression**:
   - **Success**: Mark `T-X.X` as `COMPLETED` in `docs/tasks.json` and optionally progress `current_task_id` in `docs/state.json`.
   - **Failure**: Log issues natively to `docs/failures.md`. Generate granular fallback plans in `docs/tasks.json` (e.g. `T-X.Xa`). Update findings in `docs/decisions.md`. Do NOT blindly retry failed code without logging a new atomic task.

## Guiding Directives
- Never formulate new plans. All logic comes directly from the pre-written `implementation_plan.md.resolved`.
- Only adapt systems in response to literal execution failures.
