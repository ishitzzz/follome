# Execution Pipeline Blueprint

## Architectural Strategy
The system consists of two radically decoupled layers to ensure fluid 60fps rendering unaffected by network or ML latency limits:

### Layer A: The Slow Plane (Service Worker / Asynchronous)
Handles batch API calls, LLM validation, memory persistence, and recovery engines asynchronously natively in the background thread.

### Layer B: The Fast Plane (Content Script / Synchronous UI Loop)
Maintains zero-blocked `requestAnimationFrame` updates. Blindly extracts pre-parsed queues natively without triggering ANY asynchronous network promises.

---

## Direct Data & Logic Flow

**1. Inference Trigger & Extraction**
- `conversation-watcher.js` (UI) catches AI outputs via `MutationObserver` (Sync).
- Sends raw `CONTEXT_UPDATED` text to the Service Worker mapping cache (Async message).

**2. Ingestion & Normalization**
- `StepNormalizer` strips conversational flab (Sync computation).
- Output: Exact `[{ action, target, hint }]` models constructed.
- State Update: Active Session bounds established in memory.

**3. Execution Validation & Profiling**
- ServiceWorker fetches DOM snapshot from active tab.
- `IntentProfiler` matches AI constraints vs active domains (`validatePageMatch`). If valid, proceeds.

**4. Concurrent Resolution Engine (Batch Groq)**
- `batchMapInstructions` constructs one consolidated prompt linking DOM map to all Steps.
- **Boundary**: Generates HTTP fetch block -> Awaits Groq completion.
- Returns mappings sorted by confidence (`< 0.4` triggers Fallback hooks).

**5. System Decoupling via StepQueue State**
- Data transitions natively from active network closures into `StepQueue`.
- The Queue serves as the literal boundary separating SLOW inference processes from the Fast UI polling loops.

**6. Continuous Progress & UI Loop (60fps)**
- The Fast Plane `cursor-guide` reads pointer targets from the passive StepQueue state.
- Lookahead parameters natively interpolate X/Y bounds generating zero-stop frame lerping rendering smooth trajectories.

**7. Feedback & Destabilization (Recovery Layer)**
- Injections on the DOM (popups, layout shifts) invoke `DOMStabilityMonitor`.
- Metrics over threshold invoke `recovery-engine` which re-computes `Groq` mappings for broken segments locally without freezing unbroken queued parameters.
