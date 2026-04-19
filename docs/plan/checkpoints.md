# Checkpoint Validation Framework

To prevent silent failures and ensure strict execution alignment, the pipeline enforces checks across two isolated tiers.

---

## 1. Task Checkpoints (Micro-Validation)
Executed identically upon the conclusion of every single task increment (`T-X.Y`).

**Validation Sequence**:
1. **Output Test**: Programmatically assert that the `expected_output` declared inside `tasks.json` has been achieved.
2. **Context Guard**: Confirm the resulting module throws NO compilation, schema, or export undefined errors.
3. **Execution Fork**:
   - **On Success**: Immediately mark task `status: COMPLETED` inside `tasks.json` and proceed safely to next node constraint.
   - **On Failure**: Abort execution. **Do NOT blindly retry.**

**Failing Gracefully**:
- The agent must log the precise failing vector directly into `docs/failures.md`.
- Formulate a precise, atomic adjustment task (e.g. `T-X.Ya`) prioritizing the bug, inject it into `tasks.json`, and restart the loop prioritizing the fix constraint natively.

---

## 2. Phase Checkpoints (Macro-Integration)
Executed conditionally upon the completion of all child tasks enclosed inside a designated `PHASE_X`.

**Validation Sequence**:
1. **Flow Verifications**: Prove the integrated phase executes against prior system bounds cleanly. (e.g. Ensure the newly minted Batch Groq API successfully hands data back to the intent-profiler natively without dropping promises).
2. **State Updates**: Write systemic results to `docs/tests.md` ensuring transparency in integration tests.
3. **Execution Fork**:
   - **On Success**: Upgrade global system architecture scope in `state.json` pointing `current_phase_id` identically to the next major increment boundary.
   - **On Failure**: The architectural design is flawed natively. Halt system progression. Record systemic incompatibility logic to `docs/decisions.md` highlighting how the Phase constraint must adapt to resolve boundary collision.
