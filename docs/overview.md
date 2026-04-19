# System Overview

This system provides a deterministic, agent-executable framework for developing the Chrome extension. It is designed to allow multiple AI agents to execute tasks sequentially without losing context, maintain full continuity across sessions, minimize token usage, and ensure reliable execution and recovery.

## Core Principles
1. **No Memory Dependency:** Agents reconstruct context exclusively from these documents.
2. **Deterministic Execution:** Agents follow a strict workflow. No looping or arbitrary task picking.
3. **Atomic Tasks:** Tasks are small, verifiable, and strictly sequenced.
4. **Token Efficiency:** Context provided to agents is strictly filtered. Only essential JSON state and specific docs are read.

## Document Structure
- `overview.md`: High-level principles.
- `architecture.md`: System components and skill standardization.
- `workflow.md`: How tasks are picked, executed, and tracked.
- `phases.json`: High-level milestone definitions.
- `tasks.json`: Atomic tasks list mapped to phases.
- `state.json`: Current execution state, updated dynamically.
- `decisions.md`: Append-only log of architectural or execution decisions.
- `failures.md`: Append-only log of task failures and recovery steps.
- `tests.md`: Test reports and validation criteria.
