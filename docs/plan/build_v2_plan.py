import re
import os

source_path = r"c:\Users\ishit\OneDrive\Desktop\follo-me\docs\plan\implementation_plan.md.resolved"
dest_path = r"c:\Users\ishit\OneDrive\Desktop\follo-me\docs\plan\implementation_plan.v2.resolved.md"

if not os.path.exists(source_path):
    print(f"Error: Could not find {source_path}")
    exit(1)

blocks = []
with open(source_path, "r", encoding="utf-8") as f:
    lines = f.readlines()

in_block = False
current_block = []
for line in lines:
    if line.startswith("```"):
        if in_block:
            current_block.append(line)
            blocks.append("".join(current_block))
            current_block = []
            in_block = False
        else:
            in_block = True
            current_block.append(line)
    elif in_block:
        current_block.append(line)

# Let's write the markdown file content as a template.
template = """# FolloMe — Explicit Execution-Ready System Plan (v2.resolved)

## 1. SYSTEM OVERVIEW

The FolloMe architecture is a dual-layer real-time browser assistant that converts unstructured, natural-language AI conversational directives into robust, visually-guided interactive state flows. The system runs via purely deterministic pipelines handling parsing, disambiguation, fallback, and synchronization without any blocking UI freeze. Ambiguity is resolved asynchronously via Teacher AI without switching tabs.

## 2. SYSTEM LAYERS

1. **UI Layer**: Manages the overlay, confidence status indicators, and tracking/visualizer modes (such as Speech/Microphone listening mode).
2. **Content Layer**: Houses the `CursorEngine` (60fps animation), `DOMStabilityMonitor`, and `PassiveProgressTracker` (event capture phase listeners). Operates exclusively on pre-resolved elements.
3. **Brain Layer**: Handles `StepNormalizer` (ContextCompressor, Action Extraction), splitting teacher text into explicit step/explanation channels, and computing position metadata based on natural language constraints.
4. **Mapping Layer (Groq)**: The thin reasoning bridge executing batch DOM mapping. Converts an enriched DOM snapshot plus position clues into confidence-scored DOM index references. Uses DOM_ONLY fallback primarily. Vision escalates manually.
5. **Recovery Layer**: A 3-tier cascade (`RecoveryEngine`) designed to gracefully fail-upwards. Tier 1 (Context expansion), Tier 2 (Local `ElementMatcher`), Tier 3 (`DisambiguationProtocol` querying Teacher AI).
6. **State Layer**: The single source of truth (`GuidanceSession`), bound to synchronous mutation logic tracking a `domVersion`. Pushes projection deltas (read-only) down to the runtime content scripts.
7. **Messaging Layer**: Runs strictly via Background-to-Tab channels (`chrome.tabs.sendMessage`). Guarantees zero tab-switching by injecting prompts to the background-paused Teacher AI tab directly.

## 3. FULL EXECUTION PIPELINE (STRICT)

**Execution Constraints**:
* Pipeline MUST abort if `domVersion` increments mid-flight.
* Cursor MUST NEVER block while mapping or reasoning.
* DOM parsing MUST complete before mapped steps push to state.
* Local fallbacks MUST execute prior to Vision or Teacher AI clarifications.

**Execution Flow**:
USER_PROMPT → WATCHER_DETECTS_REPLY → EXTRACT_CONTEXT → NORMALIZE_TEXT_AND_COMPRESS → VALIDATE_PAGE_DOMAIN_AND_INTENT → ACQUIRE_OP_LOCK → DOM_SNAPSHOT_CAPTURE (Version N) → BATCH_GROQ_MAPPING → EVALUATE_SCORES → [IF < 0.4] TRIGGER_RECOVERY_TIERS → [IF SUCCESS] MUTATE_SESSION_STATE_SUCCESS → [ELSE] MUTATE_SESSION_STATE_FAILED → PUSH_PROJECTION_TO_CONTENT_SCRIPT → UPDATE_STEP_QUEUE → ADVANCE_CURSOR_TRANSITION → DETECT_PROGRESS_PASSIVE_EVENT → AUTO_ADVANCE_STEP_QUEUE → REPORT_STEP_COMPLETION → REPEAT_OR_END.

## 4. DATA FLOW (STEP FORMAT)

**Normalizer Flow**:
Raw Teacher Thread → Context Compressor Node → Step Action String + Explanation → Position Clue Matcher → Array of JSON Step Actions.

**Matching/Vision Flow**:
DOM Elements State → Region Assignment Engine → Flat JSON Representation → Batch Prompt Builder → Groq Model Inference `llama-3.1-8b-instant` → JSON Mapping Result → Confidence Sorting.

**Recovery Flow (Tier 3)**:
Unresolved Step JSON → Candidate Element Array → Disambiguation Payload Gen → Messaging Layer Background Relay → Teacher AI Context Ingestion → Clarification Reply Extraction → Regex Option Parser → Updated Step ID.

## 5. DEPENDENCY GRAPH (TEXT)

Teacher AI (Upstream Source)
  ↓ (Background Message)
Conversation Watcher
  ↓ (Webhook/Port Update)
Service Worker Main Thread
  ↓
Step Normalizer → (Intent Profiler / Screenshot Manager) → Groq Mapper
  ↓ (Fallback Request)                  ↓
Recovery Engine ──────────────→ GuidanceState (Session DB)
                                        ↓ (Async Storage)
                                  SyncController (Mutex/Version Control)
                                        ↓ (Message Relay: Projection)
                              CursorEngine (Content Script)
                                        ↑ (Reads)
                                    Step Queue
                                        ↑ (Reads)
             PassiveProgressTracker + DOMStabilityMonitor + CompletionValidator

## 6. COMPONENT BREAKDOWN

All components MUST operate predictably:

* **Conversation Watcher (`watchers/conversation-watcher.js`)**: Passively reads DOM over the AI provider. Non-intrusive.
* **Service Worker (`background/service-worker.js`)**: Orchestrator. Handles `CONTEXT_UPDATED`, `REQUEST_GUIDANCE`, `VOICE_QUERY`.
* **Step Normalizer (`brain/step-normalizer.js`)**: Cleans conversational noise. Uses `ContextCompressor`.
* **Page Validator (`utils/intent-profiler.js`)**: Ensures URL matches the AI task domain. Returns match strategy.
* **Groq Mapper (`brain/groq-mapper.js`)**: Builds Batch-prompt string for Groq.
* **Recovery Engine (`brain/recovery-engine.js`)**: Implements `tier1_silentRetry`, `tier2_statusRetry`, and `tier3_userConfirmation`.
* **State Engine (`brain/guidance-state.js`)**: Owns `GuidanceSession` and `SyncController`. Protects DOM version state.
* **Cursor Guide (`content/cursor-guide.js`)**: Runs 60fps Loop `TransitionEngine`. Modifies `ConfidenceBehavior`.
* **Overlay Layer (`content/overlay.js`)**: Injects Status Badges + recovery state notification + Voice UI.
* **Speech Node (`content/speech.js`)**: Native browser SpeechRecognition to transcribe user voice actions.

## 7. CODE SNIPPETS (UNCHANGED)

All explicit code representations defined by the strict systems logic design are mapped below exactly as sourced from the architecture documents.

<<<BLOCK_0>>>
<<<BLOCK_1>>>
<<<BLOCK_2>>>
<<<BLOCK_3>>>
<<<BLOCK_4>>>
<<<BLOCK_5>>>
<<<BLOCK_6>>>
<<<BLOCK_7>>>
<<<BLOCK_8>>>
<<<BLOCK_9>>>
<<<BLOCK_10>>>
<<<BLOCK_11>>>
<<<BLOCK_12>>>
<<<BLOCK_13>>>
<<<BLOCK_14>>>
<<<BLOCK_15>>>
<<<BLOCK_16>>>
<<<BLOCK_17>>>
<<<BLOCK_18>>>
<<<BLOCK_19>>>
<<<BLOCK_20>>>
<<<BLOCK_21>>>
<<<BLOCK_22>>>
<<<BLOCK_23>>>
<<<BLOCK_24>>>
<<<BLOCK_25>>>
<<<BLOCK_26>>>
<<<BLOCK_27>>>
<<<BLOCK_28>>>
<<<BLOCK_29>>>
<<<BLOCK_30>>>
<<<BLOCK_31>>>
<<<BLOCK_32>>>
<<<BLOCK_33>>>
<<<BLOCK_34>>>
<<<BLOCK_35>>>
<<<BLOCK_36>>>
<<<BLOCK_37>>>
<<<BLOCK_38>>>
<<<BLOCK_39>>>
<<<BLOCK_40>>>
<<<BLOCK_41>>>
<<<BLOCK_42>>>
<<<BLOCK_43>>>
<<<BLOCK_44>>>
<<<BLOCK_45>>>
<<<BLOCK_46>>>
<<<BLOCK_47>>>
<<<BLOCK_48>>>
<<<BLOCK_49>>>
<<<BLOCK_50>>>
<<<BLOCK_51>>>
<<<BLOCK_52>>>
<<<BLOCK_53>>>
<<<BLOCK_54>>>
<<<BLOCK_55>>>

## 8. TASK LIST (COMPLETE)

* `TSK-01` [Phase: 0] [Description: Delete old context logic] Action: Remove context-engine.js, teacher-prompt.js, step-parser.js from project tree. Dep: None. Out: Tree pruned.
* `TSK-02` [Phase: 0] [Description: Manifest cleanup] Action: Strip redundant extensions referencing deleted files. Dep: TSK-01. Out: Valid V3 manifest.
* `TSK-03` [Phase: 0] [Description: Strip context builder code] Action: Erase `buildPrompt()` from context-extractor.js. Dep: None. Out: Slim extractor.
* `TSK-04` [Phase: 1] [Description: Add Conversation Watcher script] Action: Create watchers/conversation-watcher.js using MutationObserver. Read passive DOM output from adapter. Dep: None. Out: Watcher JS exists.
* `TSK-05` [Phase: 1] [Description: Update AI Adapters] Action: Implement extractLatestMessage() and background message listening without changing tabs. Dep: TSK-04. Out: Injectable adapters.
* `TSK-06` [Phase: 1] [Description: Orchestrate Context Handlers Worker] Action: Add CONTEXT_UPDATED handler in SW. Store Teacher state in memory logic. Dep: TSK-05. Out: Service-worker contextual awareness.
* `TSK-07` [Phase: 2] [Description: Context Compressor Implementation] Action: Write brain/step-normalizer.js with Phase 1 to Phase 3 compression steps. Implement detectFieldGroups(). Dep: None. Out: Norm code.
* `TSK-08` [Phase: 2] [Description: Page Intent Validation] Action: Introduce validatePageMatch() and getMatchingStrategy() to intent-profiler.js. Dep: None. Out: Intent Profile outputs boolean gating execution.
* `TSK-09` [Phase: 2] [Description: Region Compute Additions] Action: Add `computeRegion()` and `getElementsForMapping()` flat list logic to context-extractor.js. Dep: None. Out: Enriched extracted node array.
* `TSK-10` [Phase: 2] [Description: Batch Groq Mapper] Action: Create brain/groq-mapper.js -> batchMapInstructions() to execute 1 query per cycle for steps list. Output mapping struct array. Dep: TSK-09, TSK-07. Out: Mapper service online.
* `TSK-11` [Phase: 3] [Description: Stateful Queue Buffer] Action: Implement StepQueue in guidance-state.js. Manages pointer status + resolved properties. Dep: TSK-10. Out: Queue model created.
* `TSK-12` [Phase: 3] [Description: Stateful Guidance Session API] Action: Build GuidanceSession object wrapper handling atomic states. Integrate .persist() functionality on `mutate()`. Dep: TSK-11. Out: Isolated unified session.
* `TSK-13` [Phase: 3] [Description: Animation Transition Loop] Action: Create TransitionEngine class inside cursor-guide.js implementing Lookahead + Lerping transition algorithms. Dep: None. Out: Fluid cursor bounds.
* `TSK-14` [Phase: 3] [Description: Confidence Color Bounds] Action: Create ConfidenceBehavior switch within cursor engine handling LOW/MED/HIGH UX markers. Dep: None. Out: Reactive pointer visuals.
* `TSK-15` [Phase: 3] [Description: Event Listener Tracker] Action: Implement CompletionValidator and PassiveProgressTracker across DOM listeners for instant validation detection. Remove simple single `.once:true` callbacks. Dep: TSK-13. Out: Tracking engine ready.
* `TSK-16` [Phase: 4] [Description: DOM Version Checker] Action: Instatiate DOMStabilityMonitor within content.js pushing ranked significance numbers instead of binary updates. Dep: None. Out: Rate Limited stable DOM version stream.
* `TSK-17` [Phase: 4] [Description: Sync Worker Control] Action: Install SyncController logic in service worker wrapped over pipelines utilizing abort signal capabilities for stale versions. Dep: TSK-16. Out: Race-proof pipelines.
* `TSK-18` [Phase: 4] [Description: Recovery Engine Subsystem] Action: Develop 3-tier cascade inside brain/recovery-engine.js. Integrate silent retries against ElementMatcher and DisambiguationProtocol. Dep: TSK-10. Out: Fault-tolerant failure paths.
* `TSK-19` [Phase: 5] [Description: Native Speech Overlay] Action: Rewrite content/speech.js utilizing Native Web Speech Recognition. Inject Mic trigger button in overlay. Dep: None. Out: Voice entry ready.
* `TSK-20` [Phase: 5] [Description: Speech Styling] Action: Append pulsing visual CSS + Visualizer Cursor bindings via `CursorGuide.enterListeningMode`. Dep: TSK-19. Out: Interactive visuals active.
* `TSK-21` [Phase: 5] [Description: SW Voice Router] Action: Add `VOICE_QUERY` to service worker triggering Background Teacher prompt extraction to skip typing manual cues. Dep: TSK-19. Out: Seamless voice command entry path.

## 9. PHASES

* **Phase 0: Foundation Cleanup (Day 1)** - Scrub redundant files, simplify extension surface area, clear dead context code. Focus strictly on modularizing tools for future scale.
* **Phase 1: Passive Observer (Day 2)** - Deploy silent Conversation Watcher models into AI host systems. Remove UI interruptions while polling. Bind to Memory.
* **Phase 2: Step Normalizer & Batch Process (Day 3-4)** - Strip raw responses into compressed task blocks. Attach geometric positional attributes. Dispatch single-query batches to APIs to reduce blocking times from O(n) to O(1).
* **Phase 3: Cursor Mechanics (Day 4-5)** - Connect shared state StepQueue. Inject `TransitionEngine` for lookahead and smoothing. Integrate `PassiveProgressTracker` so tracking continues without stopping on partial completion.
* **Phase 4: DOM Consistency & Recovery (Day 5-6)** - Fortify DOM change triggers with stability scoring formulas. Handle stale execution using SyncController Abort structures. Expose recovery tiers up to Teacher queries natively.
* **Phase 5: Interface Polish & Auditory Hooks (Day 7)** - Mount overlay tweaks. Embed zero-latency Voice queries processing. Review error messages. Verify offline fallbacks. Execute final automated suite test cases against dynamic layouts.

## 10. FAILURE HANDLING

1. **Groq Model Latency / API Outage**:
   - `Event`: Groq fails to return mappings or API keys reject.
   - `Handling`: Handshake instantly defaults to Tier 2 local fuzzy matching (ElementMatcher) which checks substrings and ARIA similarities locally without network requirements. `GuidanceSession` increments failure log.
2. **Tab Switch & Disambiguation UI Loss**:
   - `Event`: Teacher requests clarification leading to chaotic background windowing problems.
   - `Handling`: Disambiguation UI natively implemented over User Chrome via Overlay logic communicating via Message channels mapping via `chrome.tabs.sendMessage()`. Never calls to `chrome.tabs.update()`. Screen context is preserved flawlessly.
3. **Mid-Flight Layout Navigation (Single Page App Reload)**:
   - `Event`: Javascript navigation routes while mapped steps are running via content queues.
   - `Handling`: DOMTracker identifies scoring sum beyond 100 on `DOM_SIGNIFICANT_CHANGE`. The active mapping procedure is instantly nullified via `AbortController().abort()`. The `DOMVersion_N` increments forcing the CursorEngine to block and reload the step queue from scratch cleanly.

## 11. EDGE CASES

1. **Partially Renamed Items (A/B Test Elements)**: If exact match fails due to DOM text alterations. System relies on `ElementMatcher.resolvePartialMatch(<step>)` requiring fractional subset string equality. Confidence adjusts visual indicator. User observes amber guide with options.
2. **Canvas Embedded Applications (Figma / WebGL)**: No standard DOM inputs exist. `validatePageMatch` detects zero typical interactive targets & marks tool profile. Recovery intelligently escalates via Screenshot inference forcing fallback to VLM (`llama-3.2-11b-vision-preview`).
3. **Compound Form Inputs**: Date fields composed of Three Selectors. Handled gracefully by `detectFieldGroups()` preprocessing routine scaling instructions into discrete sub-steps dynamically handled by the single cursor sequentially.
4. **Incorrect Input Type Interaction**: User completes form check out of bounds (types phone layout within an email parameter set). Cursor `CompletionValidator` halts progression flagging missing requirements over `.email` formatted input boxes via explicit validation checks locally parsed.

## 12. EXECUTION VALIDATION CHECKS

**Pre-Execution Checks:**
- Ensure `domVersion` aligns exactly between State Layers and Scanner definitions.
- Ensure API variables populate memory cache and watch channels transmit.
- Enforce Step Normalization rules to verify Action Strings conform to regex bounds.

**Runtime Checks:**
- Evaluate confidence markers continuously before dispatching animation interpolation nodes inside the TransitionEngine.
- Validate `cursor-guide` execution avoids arbitrary `await` implementations inside `requestAnimationFrame`.

**Post-Execution Validation:**
- Assess `.once` callbacks appropriately detaching to prevent memory leakage within Content script limits dynamically across `CompletionValidator`.
- Audit timeline traces array produced sequentially inside `.mutate()` tracking exact path to resolution completion states perfectly linearly.

"""

for i, block in enumerate(blocks):
    # Ensure replacement targets exact string without issues
    target = f"<<<BLOCK_{i}>>>"
    template = template.replace(target, block.strip() + "\n")

with open(dest_path, "w", encoding="utf-8") as out:
    out.write(template)

print("Done generating V2 Implementation Plan.")
