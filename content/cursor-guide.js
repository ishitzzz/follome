/**
 * FolloMe — Persistent Cursor Guide Engine
 *
 * Architecture:
 *   - ONE cursor div, ONE label div — created once, never removed
 *   - Global state on window (folloSteps, currentStep)
 *   - requestAnimationFrame loop drives smooth lerp movement
 *   - No async/await chains for rendering
 *   - Steps advance ONLY on real user interaction (not timers)
 *   - Cursor stays visible at all times once activated
 *
 * Step State Machine: idle → guiding → waiting → completed
 *
 * Public API (consumed by overlay.js):
 *   processResponse, getExplanation, guideTo, clearAll,
 *   pause, resume, skip, replay, onGuideStateChange, getState
 */

const FolloCursorGuide = (() => {

  // ══════════════════════════════════════════
  //  GLOBAL STATE
  // ══════════════════════════════════════════

  // Persisted on window so they survive across calls
  window.folloSteps = [];
  window.folloCurrentStep = 0;

  let cursorEl = null;       // single cursor div
  let labelEl = null;        // single label div
  let tooltipEl = null;      // single tooltip div
  let highlightEl = null;    // single highlight div
  let badgeEl = null;        // single step-badge div

  let currentX = -100;       // cursor's current position (off-screen start)
  let currentY = -100;
  let targetX = -100;        // where cursor wants to go
  let targetY = -100;
  let targetRect = null;     // bounding rect of current target element

  // ── Lookahead interpolator state (T-4.2) ──
  let lookaheadX = -100;     // pre-computed centroid of Step[N+1]
  let lookaheadY = -100;
  let isTransitioning = false; // true during post-action snap to next element

  let isActive = false;      // guide loop running
  let isPaused = false;
  let arrived = false;       // cursor reached target
  const LERP_SPEED = 0.12;      // guiding movement smoothing factor
  const TRANSITION_LERP_SPEED = 0.22; // faster snap on step advance (T-4.2)
  const NEAR_THRESHOLD = 8;  // px distance to consider "arrived"
  const LOOKAHEAD_DRIFT = 0.015; // subtle exit-velocity bleed toward Step[N+1]

  // ── Step state machine ──
  // Each step progresses: idle → guiding → waiting → completed
  const STEP_STATE = { IDLE: 'idle', GUIDING: 'guiding', WAITING: 'waiting', COMPLETED: 'completed' };
  let currentStepState = STEP_STATE.IDLE;
  let activeInteractionCleanup = null; // function to remove current event listener

  let onStateChange = null;  // overlay callback

  // ── Last extracted UI elements (for matcher) ──
  let lastUIElements = [];

  // ── Confidence thresholds (raised — reject below 40) ──
  const CONFIDENCE = { HIGH: 60, LOW: 40, NONE: 0 };

  // ── Action patterns for regex parsing ──
  const ACTION_PATTERNS = [
    { regex: /\b(?:click|tap|press|hit)\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?\s*(?:button|link|icon|tab|menu|option|checkbox|radio|toggle|element|field|area)?(?:\s*$|[.,;!])/gim, action: 'click' },
    { regex: /\b(?:type|enter|input|write|fill\s+in)\s+['"]?(.+?)['"]?\s+(?:in(?:to)?|on)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'type' },
    { regex: /\b(?:select|choose|pick)\s+['"]?(.+?)['"]?\s+(?:from|in)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'select' },
    { regex: /\b(?:scroll)\s+(?:down\s+|up\s+)?(?:to|until)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'scroll' },
    { regex: /\b(?:focus|navigate\s+to|go\s+to|find|locate|look\s+(?:for|at))\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s*$|[.,;!])/gim, action: 'focus' },
  ];

  const ACTION_LABELS = {
    click:  'Click here',
    type:   'Type here',
    select: 'Select here',
    scroll: 'Scroll here',
    focus:  'Look here',
    fallback: 'Here',
  };


  // ══════════════════════════════════════════
  //  CONFIDENCE-BASED BEHAVIOR TIERS (v3)
  // ══════════════════════════════════════════

  const ConfidenceBehavior = {

    /**
     * Returns the UX behavior for a step based on its confidence.
     * Runs in the FAST LAYER — no async, no API calls.
     *
     * @param {object} step — { confidence, ... }
     * @returns {{ tier: string, highlightColor: string, showAlternates: boolean,
     *             requireConfirmation: boolean, cursorStyle: string, transitionSpeed: number }}
     */
    getBehavior(step) {
      const conf = step.confidence;

      if (conf >= 0.85) {
        // HIGH — direct execution: cursor moves, highlight, auto-advance on action
        return {
          tier: 'HIGH',
          highlightColor: '#22c55e',     // green
          showAlternates: false,
          requireConfirmation: false,
          cursorStyle: 'confident',       // solid, no wobble
          transitionSpeed: 1.0            // full speed
        };
      }

      if (conf >= 0.5) {
        // MEDIUM — highlight with options: show the match + top alternate
        return {
          tier: 'MEDIUM',
          highlightColor: '#f59e0b',     // amber
          showAlternates: true,           // show "Did you mean X?" below label
          requireConfirmation: false,     // still auto-advance on action
          cursorStyle: 'uncertain',       // slight pulse effect
          transitionSpeed: 0.85           // slightly slower approach
        };
      }

      // LOW — ask user: show candidates, don't auto-advance
      return {
        tier: 'LOW',
        highlightColor: '#ef4444',       // red
        showAlternates: true,
        requireConfirmation: true,        // wait for user to pick
        cursorStyle: 'searching',         // orbit animation
        transitionSpeed: 0.6              // gentle drift
      };
    },

    /**
     * Apply visual styling to cursor based on behavior tier.
     * Called every frame — no allocations, just class toggles.
     *
     * @param {HTMLElement} el — cursor DOM element
     * @param {object} behavior — from getBehavior()
     */
    applyCursorStyle(el, behavior) {
      if (!el) return;
      // Preserve base class, swap the tier-specific class
      el.className = `follo-cursor ${behavior.cursorStyle}`;
      // Keep 'active' class if guide is running
      if (isActive) el.classList.add('active');
    }
  };


  // ══════════════════════════════════════════
  //  TRANSITION ENGINE (v3 — Zero-Pause)
  // ══════════════════════════════════════════

  /**
   * Handles ALL cursor position computation.
   * Called every rAF frame by the main loop.
   * Owns the state machine: idle → approaching → dwelling → transitioning.
   */
  const TransitionEngine = {
    _currentTarget: null,     // element cursor is at / moving toward
    _nextTarget: null,        // pre-computed next target (lookahead)
    _transitionPhase: 'idle', // idle | approaching | dwelling | transitioning
    _dwellStartTime: 0,
    _DWELL_MIN: 200,         // minimum ms to stay at a target (prevents flickering)

    /**
     * Called every rAF frame. Returns { x, y } for cursor position.
     * Handles smooth transitions without ANY pauses.
     *
     * @param {number} timestamp — rAF timestamp
     * @returns {{ x: number, y: number }}
     */
    computePosition(timestamp) {
      // Need a StepQueue reference — use the local stepQueue or fall back to window globals
      const queue = (typeof stepQueue !== 'undefined' && stepQueue) ? stepQueue : null;

      const currentStep = queue ? queue.getCurrentStep() :
        (window.folloSteps && window.folloSteps[window.folloCurrentStep] ? window.folloSteps[window.folloCurrentStep] : null);
      const nextStep = queue ? queue.peekNext() :
        (window.folloSteps && window.folloSteps[window.folloCurrentStep + 1] ? window.folloSteps[window.folloCurrentStep + 1] : null);

      // ── NO STEPS: float gently ──
      if (!currentStep) return this._float(timestamp);

      // ── STEP PENDING (brain hasn't resolved): drift toward expected area ──
      if (currentStep.status === 'pending') {
        return this._driftToArea(currentStep);
      }

      // ── RESOLVE TARGET ELEMENT ──
      const el = resolveElement(currentStep);
      if (!el) {
        // Element gone — smoothly fade and move on
        if (queue) queue.advance(); else advanceStep();
        return { x: currentX, y: currentY }; // hold position this frame
      }

      const rect = el.getBoundingClientRect();
      const tx = rect.left + rect.width / 2;
      const ty = rect.top + rect.height / 2;

      // ── APPROACHING: lerp toward target ──
      if (this._transitionPhase === 'idle' || this._transitionPhase === 'transitioning') {
        this._currentTarget = { x: tx, y: ty, rect };
        this._transitionPhase = 'approaching';
      }

      const behavior = ConfidenceBehavior.getBehavior(currentStep);
      const speed = LERP_SPEED * behavior.transitionSpeed;

      currentX += (tx - currentX) * speed;
      currentY += (ty - currentY) * speed;

      const dist = Math.hypot(tx - currentX, ty - currentY);

      // ── ARRIVED: show highlight, start tracking ──
      if (dist < NEAR_THRESHOLD && this._transitionPhase === 'approaching') {
        this._transitionPhase = 'dwelling';
        this._dwellStartTime = timestamp;

        showHighlight(rect);
        showStepLabel(currentStep, behavior);

        // Apply confidence-based cursor style
        ConfidenceBehavior.applyCursorStyle(cursorEl, behavior);

        // Pre-compute next target for lookahead
        if (nextStep && nextStep.status === 'resolved') {
          const nextEl = resolveElement(nextStep);
          if (nextEl) {
            const nextRect = nextEl.getBoundingClientRect();
            this._nextTarget = {
              x: nextRect.left + nextRect.width / 2,
              y: nextRect.top + nextRect.height / 2,
              rect: nextRect
            };
          }
        }

        if (behavior.requireConfirmation) {
          showCandidateOptions(currentStep); // LOW confidence — user picks
        }
      }

      // ── DWELLING: cursor stays, but begins subtle lean toward next target ──
      if (this._transitionPhase === 'dwelling' && this._nextTarget) {
        const dwellTime = timestamp - this._dwellStartTime;
        if (dwellTime > this._DWELL_MIN && currentStep.status === 'completed') {
          // Step was completed during dwell — begin smooth transition
          this._transitionPhase = 'transitioning';
          arrived = false;
          hideHighlight();

          // DON'T snap — let the lerp naturally move toward next target
          if (queue) queue.advance(); else advanceStep();
        } else if (dwellTime > 1000) {
          // Even if not completed, start leaning toward next (3% pull)
          currentX += (this._nextTarget.x - currentX) * 0.03;
          currentY += (this._nextTarget.y - currentY) * 0.03;
        }
      }

      return { x: currentX, y: currentY };
    },

    /**
     * Gentle floating animation when no active target.
     * Cursor orbits slowly — feels alive, not frozen.
     *
     * @param {number} timestamp
     * @returns {{ x: number, y: number }}
     */
    _float(timestamp) {
      const amplitude = 20;
      const speed = 0.001;
      currentX += Math.sin(timestamp * speed) * 0.5;
      currentY += Math.cos(timestamp * speed * 1.3) * 0.5;
      return { x: currentX, y: currentY };
    },

    /**
     * Drift toward the expected AREA of a pending step.
     * Uses the instruction text to estimate position even before Groq resolves.
     * E.g., "Enter email" → drift toward the form area (top-center of page).
     *
     * @param {object} pendingStep
     * @returns {{ x: number, y: number }}
     */
    _driftToArea(pendingStep) {
      // Use position hint if available
      const hint = pendingStep.positionHint;
      let driftX = window.innerWidth / 2;
      let driftY = window.innerHeight / 3; // default to upper-third

      if (hint) {
        const hintStr = typeof hint === 'string' ? hint : (hint.region || '');
        if (hintStr.includes('top')) driftY = window.innerHeight * 0.2;
        if (hintStr.includes('bottom')) driftY = window.innerHeight * 0.8;
        if (hintStr.includes('left')) driftX = window.innerWidth * 0.25;
        if (hintStr.includes('right')) driftX = window.innerWidth * 0.75;
      }

      // Very slow drift (5% lerp) — not snapping, just gently moving
      currentX += (driftX - currentX) * 0.05;
      currentY += (driftY - currentY) * 0.05;
      return { x: currentX, y: currentY };
    },

    /**
     * Reset transition state (called on clearAll / replay).
     */
    reset() {
      this._currentTarget = null;
      this._nextTarget = null;
      this._transitionPhase = 'idle';
      this._dwellStartTime = 0;
    }
  };


  // ══════════════════════════════════════════
  //  DOM HELPERS
  // ══════════════════════════════════════════

  function getDirectTextContent(el) {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    return text || el.textContent || '';
  }

  function isVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch { return false; }
  }


  // ══════════════════════════════════════════
  //  ELEMENT RESOLUTION (v3 helpers)
  // ══════════════════════════════════════════

  /**
   * Resolve a step to a live DOM element.
   * Checks multiple sources: direct _el ref, selector, ContextExtractor idx.
   *
   * @param {object} step — { element, _el, elementSelector, elementIdx, ... }
   * @returns {HTMLElement|null}
   */
  function resolveElement(step) {
    if (!step) return null;

    // 1. Direct DOM reference (from processResponse / local resolution)
    if (step.element && isVisible(step.element)) return step.element;
    if (step._el && isVisible(step._el)) return step._el;

    // 2. CSS selector
    if (step.elementSelector) {
      try {
        const el = document.querySelector(step.elementSelector);
        if (el && isVisible(el)) return el;
      } catch { /* invalid selector */ }
    }

    // 3. ContextExtractor index
    if (step.elementIdx !== undefined && step.elementIdx !== null && typeof ContextExtractor !== 'undefined') {
      try {
        const elements = ContextExtractor.getUIElements();
        const el = ContextExtractor.getElementByIndex(elements, step.elementIdx);
        if (el && isVisible(el)) return el;
      } catch { /* extractor may not be available */ }
    }

    return null;
  }

  /**
   * Show step label with confidence-appropriate styling.
   *
   * @param {object} step — { instruction, action, stepNum, ... }
   * @param {object} behavior — from ConfidenceBehavior.getBehavior()
   */
  function showStepLabel(step, behavior) {
    const actionLabel = ACTION_LABELS[step.action] || ACTION_LABELS.fallback;
    const instruction = step.instruction || step.description || step.target || actionLabel;
    const stepNum = step.stepNum || step.index;
    const prefix = stepNum !== undefined ? `${stepNum + 1}. ` : '';
    const labelText = `${prefix}${instruction}`;

    if (targetRect) {
      showLabel(labelText, targetRect.left, targetRect.bottom);
      if (tooltipEl) {
          tooltipEl.innerText = step.text || step.instruction || 'Action required';
          tooltipEl.style.display = 'block';
      }
    }

    // Color the highlight border based on confidence tier
    if (highlightEl && behavior) {
      highlightEl.style.borderColor = behavior.highlightColor;
    }
  }

  /**
   * Show candidate options for LOW confidence steps.
   * Displays alternates so user can pick the correct element.
   *
   * @param {object} step — { alternates, ... }
   */
  function showCandidateOptions(step) {
    // Placeholder for now — will be implemented as part of the overlay integration.
    // LOW confidence steps show "Did you mean?" options.
    if (step.alternates && step.alternates.length > 0) {
      console.log(`[FolloMe] LOW confidence — showing ${step.alternates.length} alternates for user selection`);
    }
  }

  /**
   * Update the step counter display in the overlay.
   *
   * @param {number} current — 1-indexed current step number
   * @param {number} total — total step count
   */
  function updateStepCounter(current, total) {
    // Emit to overlay via event — overlay.js listens and updates its counter
    window.dispatchEvent(new CustomEvent('follome-step-update', {
      detail: { current, total }
    }));
  }



  // ══════════════════════════════════════════
  //  INTENT DETECTION
  // ══════════════════════════════════════════

  /**
   * Detect if the AI response contains actionable guidance.
   * Returns true only if the response has clear step-based instructions.
   * Informational, explanatory, or descriptive responses return false.
   */
  function isActionableResponse(responseText) {
    if (!responseText) return false;
    const text = responseText.trim();

    // Positive signal: has an actions JSON block
    if (/```actions/i.test(text)) return true;

    // Positive signal: has JSON with "action" keys
    if (/"action"\s*:\s*"(click|type|select|scroll|focus|hover|toggle|wait)"/i.test(text)) return true;

    // Positive signal: has action verbs in imperative form
    const actionVerbs = /\b(click|tap|press|type|enter|select|choose|scroll|navigate|go to|fill in|check|toggle|submit)\b/gi;
    const matches = text.match(actionVerbs) || [];
    if (matches.length >= 2) return true; // at least 2 action verbs suggests steps

    // Positive signal: numbered steps with action verbs
    if (/\d+[.)].*(click|type|enter|select|press|tap|fill|check|submit)/i.test(text)) return true;

    // Negative signals — purely informational
    const informationalPatterns = [
      /^(this|that|the|it|here)\s+(is|are|was|were|page|website|shows|displays)/i,
      /^(you are|you're)\s+(on|at|viewing|looking)/i,
      /^(welcome|hello|hi)\b/i,
    ];
    const isInformational = informationalPatterns.some(p => p.test(text));
    if (isInformational && matches.length < 2) return false;

    // Default: if short and no action verbs, not actionable
    if (text.length < 100 && matches.length === 0) return false;

    return matches.length >= 1;
  }


  // ══════════════════════════════════════════
  //  RESPONSE NORMALIZATION
  // ══════════════════════════════════════════

  /**
   * Normalize raw AI response text into a clean ```actions [...] ``` block.
   * Returns null if the response is not actionable (informational only).
   *
   * Handles malformed patterns:
   *   - actions[{...}]         (no space/backticks)
   *   - ```json [...] ```      (wrong language tag)
   *   - plain JSON array       (no wrapper at all)
   *   - text + JSON mixed      (preamble/postamble junk)
   *   - single JSON object     (not wrapped in array)
   *   - trailing commas        (common LLM mistake)
   *   - unquoted keys          (common LLM mistake)
   *
   * Returns: { normalized: string, method: string } | null
   */
  /**
   * Parse actions from AI response utilizing the deterministic StepParser.
   * Returns empty array if response is not actionable.
   */
  function parseActions(responseText) {
    if (!responseText) return [];
    
    let actions = [];
    if (typeof StepParser !== 'undefined') {
      actions = StepParser.parse(responseText);
    } 

    if (actions.length > 0) {
      console.log(`[FolloMe] StepParser extracted ${actions.length} valid actions`);
      return actions.map((a, i) => ({
        ...a,
        description: a.target, // Map target to description for UI logs
        stepNum: i + 1,
        rawLine: a.target
      }));
    }

    console.log('[FolloMe] No actions found by StepParser fallback check');
    return [];
  }

  function extractExplanation(responseText) {
    if (!responseText) return '';
    let cleaned = responseText.replace(/```(?:actions|json)?\s*\n?[\s\S]*?\n?```/gi, '').trim();
    cleaned = cleaned.replace(/(?:actions\s*:\s*)?(\[\s*\{\s*"action"[\s\S]*?\])/i, '').trim();
    return cleaned;
  }


  // ══════════════════════════════════════════
  //  ELEMENT RESOLUTION DELEGATION
  // ══════════════════════════════════════════

  function resolveAllActions(actions) {
    if (typeof ElementMatcher === 'undefined') {
      console.warn('[FolloMe] ElementMatcher is missing, cannot resolve actions.');
      return actions.map(a => ({ ...a, element: null, score: 0, confidence: 'none', reasons: [] }));
    }

    const resolved = ElementMatcher.resolveAllActions(actions);
    return resolved.map((res, i) => {
      let confidence = 'none';
      if (res.score >= CONFIDENCE.HIGH) confidence = 'high';
      else if (res.score >= CONFIDENCE.LOW) confidence = 'low';

      return {
        ...res,
        stepNum: res.stepNum || (actions.length > 1 ? i + 1 : null),
        confidence,
        reasons: [`score: ${res.score}`]
      };
    });
  }


  // ══════════════════════════════════════════
  //  SINGLE-INSTANCE DOM ELEMENTS
  // ══════════════════════════════════════════

  function ensureCursor() {
    if (cursorEl && cursorEl.parentNode) return;

    cursorEl = document.createElement('div');
    cursorEl.id = 'follome-cursor';
    cursorEl.style.position = 'fixed';
    document.body.appendChild(cursorEl);

    labelEl = document.createElement('div');
    labelEl.id = 'follome-cursor-label';
    document.body.appendChild(labelEl);

    tooltipEl = document.createElement('div');
    tooltipEl.id = 'follo-tooltip';
    tooltipEl.style.cssText = 'position: absolute; top: 40px; left: 50%; transform: translateX(-50%); width: max-content; max-width: 250px; background: #1e1e1e; color: white; padding: 10px; border-radius: 8px; font-family: sans-serif; font-size: 14px; pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5); display: none; z-index: 2147483647; text-align: center;';
    cursorEl.appendChild(tooltipEl);

    highlightEl = document.createElement('div');
    highlightEl.id = 'follome-cursor-highlight';
    document.body.appendChild(highlightEl);

    badgeEl = document.createElement('div');
    badgeEl.id = 'follome-cursor-badge';
    document.body.appendChild(badgeEl);

    // Position off-screen initially
    setCursorPos(-100, -100);
    hideLabel();
    hideHighlight();
    hideBadge();

    console.log('[FolloMe] CursorGuide: Persistent cursor created');
  }

  function setCursorPos(x, y) {
    if (!cursorEl) return;
    cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function showLabel(text, x, y) {
    if (!labelEl) return;
    labelEl.textContent = text;
    labelEl.style.transform = `translate3d(${x}px, ${y + 20}px, 0)`;
    labelEl.classList.add('visible');
  }

  function hideLabel() {
    if (!labelEl) return;
    labelEl.classList.remove('visible');
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function showHighlight(rect) {
    if (!highlightEl) return;
    highlightEl.style.left = `${rect.left - 4}px`;
    highlightEl.style.top = `${rect.top - 4}px`;
    highlightEl.style.width = `${rect.width + 8}px`;
    highlightEl.style.height = `${rect.height + 8}px`;
    highlightEl.classList.add('visible');
  }

  function hideHighlight() {
    if (!highlightEl) return;
    highlightEl.classList.remove('visible');
  }

  function showBadge(num, x, y) {
    if (!badgeEl) return;
    badgeEl.textContent = num;
    badgeEl.style.transform = `translate3d(${x - 28}px, ${y - 28}px, 0)`;
    badgeEl.classList.add('visible');
  }

  function hideBadge() {
    if (!badgeEl) return;
    badgeEl.classList.remove('visible');
  }


  // ══════════════════════════════════════════
  //  rAF GUIDANCE LOOP (v3 — final architecture)
  //  The loop is TINY. All intelligence is in:
  //  - TransitionEngine (position computation)
  //  - PassiveProgressTracker (completion detection) — NOT YET IMPLEMENTED
  //  - ConfidenceBehavior (visual styling)
  //  None of them do async work. None of them call APIs.
  // ══════════════════════════════════════════

  // v3 StepQueue instance (content-script side)
  let stepQueue = null;

  /**
   * Initialize the cursor engine with a StepQueue (from v3 pipeline).
   * Called by content.js when it receives GUIDANCE_START from service worker.
   *
   * @param {StepQueue} queue
   */
  function initWithQueue(queue) {
    stepQueue = queue;
    _attachStepCompleteListener(); // Ensure completion events are wired
  }

  /**
   * Update resolved steps from the service worker.
   * Called when content.js receives STEPS_RESOLVED message.
   *
   * @param {Array} updates — resolved step data from batch mapping
   */
  function updateSteps(updates) {
    if (!stepQueue || !updates) return;
    for (const update of updates) {
      if (update.index !== undefined) {
        stepQueue.pushResolved(update.index, update);
      }
    }
  }

  // ── PassiveProgressTracker completion listener (registered once) ──
  let _stepCompleteListenerAttached = false;

  function _attachStepCompleteListener() {
    if (_stepCompleteListenerAttached) return;
    _stepCompleteListenerAttached = true;

    window.addEventListener('follome-step-complete', (e) => {
      const detail = e.detail || {};
      console.log(`[FolloMe] Step complete event received (step ${(detail.stepIndex ?? '?') + 1}, action: ${detail.action})`);

      // Advance via StepQueue (v3) or legacy advanceStep
      if (stepQueue) {
        stepQueue.advance();
      } else {
        advanceStep();
      }

      // Reset TransitionEngine so it smoothly moves to next target
      arrived = false;
      TransitionEngine._transitionPhase = 'idle';
      TransitionEngine._nextTarget = null;
      hideHighlight();
    });
  }

  function runLoop(timestamp) {
    if (!isActive) return;
    requestAnimationFrame(runLoop);
    if (isPaused) return;

    // 1. Compute cursor position (TransitionEngine handles ALL states)
    const pos = TransitionEngine.computePosition(timestamp);
    setCursorPos(pos.x - 10, pos.y - 10);

    // 2. Passive tracker completion is handled via event listener (follome-step-complete)
    //    registered in _attachStepCompleteListener() — no polling needed here.

    // 3. Update overlay step counter (cheap — just DOM text update)
    if (stepQueue) {
      const step = stepQueue.getCurrentStep();
      if (step) {
        updateStepCounter(stepQueue._activeStep + 1, stepQueue._steps.length);
      }
    } else {
      // Legacy fallback: use window.folloSteps
      const steps = window.folloSteps;
      const stepIdx = window.folloCurrentStep;
      if (steps && stepIdx < steps.length) {
        updateStepCounter(stepIdx + 1, steps.length);
      }
    }
  }


  function advanceStep() {
    // ── Seed cursor from lookahead before resetting (T-4.2) ──
    // If lookahead was pre-computed while waiting, cursor is already drifting that direction.
    // We keep currentX/Y as-is (don't cold-reset) so the transition appears fluid.
    const hadLookahead = lookaheadX > 0 && lookaheadY > 0;

    arrived = false;
    lookaheadX = -100;
    lookaheadY = -100;
    currentStepState = STEP_STATE.IDLE;
    hideLabel();
    hideHighlight();
    hideBadge();
    if (cursorEl) cursorEl.classList.remove('arrived');

    window.folloCurrentStep++;
    emitState();

    if (window.folloCurrentStep >= window.folloSteps.length) {
      console.log('[FolloMe] CursorGuide: All steps complete');
    } else if (hadLookahead) {
      // Engage transition phase — cursor LERPs fast from current position to next target
      isTransitioning = true;
      console.log(`[FolloMe] TransitionEngine: fast-lerp to Step[${window.folloCurrentStep + 1}] (lookahead was ready)`);
    }
  }


  // ══════════════════════════════════════════
  //  STATE MANAGEMENT
  // ══════════════════════════════════════════

  function emitState() {
    if (onStateChange) {
      onStateChange({
        isRunning: isActive,
        isPaused,
        currentStep: window.folloCurrentStep,
        totalSteps: window.folloSteps.length,
        steps: window.folloSteps.map((s, i) => ({
          action: s.action,
          description: s.description,
          confidence: s.confidence,
          score: s.score,
          isCurrent: i === window.folloCurrentStep,
        })),
      });
    }
  }


  // ══════════════════════════════════════════
  //  MAIN ENTRY POINTS
  // ══════════════════════════════════════════

  /**
   * Main entry — process AI response, extract actions, start guidance loop.
   */
  function processResponse(responseText) {
    console.log('[FolloMe] ▶▶▶ CursorGuide.processResponse CALLED');
    console.log('[FolloMe] Raw response length:', responseText?.length);
    console.log('[FolloMe] Raw response preview:', (responseText || '').substring(0, 300));

    // ── INTENT FILTER: Skip cursor for non-actionable responses ──
    if (!isActionableResponse(responseText)) {
      console.log('[FolloMe] Response is informational — showing overlay text only, no cursor guidance');
      return; // overlay.js already shows the text
    }

    // Refresh UI elements for matching
    if (typeof ContextExtractor !== 'undefined') {
      try {
        lastUIElements = ContextExtractor.getUIElements();
        console.log(`[FolloMe] Extracted ${lastUIElements.length} UI elements for matching`);
      } catch (e) {
        console.warn('[FolloMe] UI element extraction failed:', e);
        lastUIElements = [];
      }
    }

    // Parse actions (may return empty if not actionable)
    const actions = parseActions(responseText);
    console.log(`[FolloMe] Parsed actions: ${actions.length}`);

    if (!actions || actions.length === 0) {
      console.log('[FolloMe] No actionable steps parsed — cursor not activated');
      return;
    }

    // Resolve actions to DOM elements
    const steps = resolveAllActions(actions);

    // Log each step
    steps.forEach((s, i) => {
      const elTag = s.element ? `<${s.element.tagName.toLowerCase()}>` : 'NULL';
      console.log(
        `[FolloMe]   Step ${i + 1}: ${s.action} "${s.description}" → ${elTag} ` +
        `(confidence: ${s.confidence}, score: ${s.score}, reasons: [${s.reasons.join(', ')}])`
      );
    });

    // Filter to steps with visible elements AND sufficient confidence (score >= 40)
    const validSteps = steps.filter(s => s.element && isVisible(s.element) && s.score >= CONFIDENCE.LOW);
    console.log(`[FolloMe] ${validSteps.length}/${steps.length} steps have confident visible elements`);

    if (validSteps.length === 0) {
      console.warn('[FolloMe] No confident matches — cursor not activated');
      steps.forEach(s => {
        window.dispatchEvent(new CustomEvent('follome-guide-nomatch', {
          detail: { action: s.action, description: s.description, rawLine: s.rawLine }
        }));
      });
      return;
    }

    // Store globally and start
    window.folloSteps = validSteps;
    window.folloCurrentStep = 0;
    arrived = false;
    currentStepState = STEP_STATE.IDLE;
    detachInteractionListener();

    // Create cursor elements if needed
    ensureCursor();
    cursorEl.classList.add('active');

    // Position cursor at starting point (top-right of viewport)
    currentX = window.innerWidth - 60;
    currentY = 80;
    setCursorPos(currentX - 10, currentY - 10);

    // Start the loop
    _attachStepCompleteListener(); // Wire passive tracker completion events
    if (!isActive) {
      isActive = true;
      requestAnimationFrame(runLoop);
    }
    isPaused = false;
    emitState();

    console.log(`[FolloMe] ✓ Guidance started: ${validSteps.length} steps (waiting for user interaction)`);
  }

  /**
   * Get explanation text (stripped of action JSON)
   */
  function getExplanation(responseText) {
    return extractExplanation(responseText);
  }

  /**
   * Manually guide cursor to a CSS selector
   */
  function guideTo(selector, actionType = 'click', labelText = null) {
    console.log(`[FolloMe] guideTo: "${selector}"`);
    try {
      const el = document.querySelector(selector);
      if (!el || !isVisible(el)) {
        console.warn(`[FolloMe] guideTo: element not found — ${selector}`);
        return;
      }

      // Set up as single-step guidance
      window.folloSteps = [{
        action: actionType,
        description: labelText || selector,
        target: selector,
        element: el,
        score: 100,
        confidence: 'high',
        reasons: ['manual selector'],
        stepNum: 1,
        rawLine: selector,
      }];
      window.folloCurrentStep = 0;
      arrived = false;

      ensureCursor();
      cursorEl.classList.add('active');

      if (!isActive) {
        isActive = true;
        requestAnimationFrame(runLoop);
      }
      isPaused = false;
      emitState();
    } catch (err) {
      console.warn('[FolloMe] guideTo error:', err);
    }
  }


  // ══════════════════════════════════════════
  //  PLAYBACK CONTROLS
  // ══════════════════════════════════════════

  function pause() {
    if (!isActive || isPaused) return;
    isPaused = true;
    if (cursorEl) cursorEl.classList.add('paused');
    emitState();
  }

  function resume() {
    if (!isPaused) return;
    isPaused = false;
    if (cursorEl) cursorEl.classList.remove('paused');
    emitState();
  }

  function skip() {
    if (!isActive) return;
    advanceStep();
  }

  function replay() {
    if (window.folloSteps.length === 0) return;

    // Re-resolve elements (they may have moved)
    const rawActions = window.folloSteps.map(s => ({
      action: s.action,
      description: s.description,
      target: s.target,
      stepNum: s.stepNum,
      rawLine: s.rawLine,
      idx: s.idx,
      value: s.value,
    }));

    const steps = resolveAllActions(rawActions);
    const validSteps = steps.filter(s => s.element && isVisible(s.element));

    if (validSteps.length === 0) {
      console.warn('[FolloMe] Replay: no valid steps remain');
      return;
    }

    window.folloSteps = validSteps;
    window.folloCurrentStep = 0;
    arrived = false;
    isPaused = false;

    // Reset cursor to start position
    currentX = window.innerWidth - 60;
    currentY = 80;

    hideLabel();
    hideHighlight();
    hideBadge();

    if (!isActive) {
      isActive = true;
      requestAnimationFrame(runLoop);
    }

    if (cursorEl) {
      cursorEl.classList.remove('arrived', 'paused');
      cursorEl.classList.add('active');
    }

    emitState();
    console.log(`[FolloMe] Replay started: ${validSteps.length} steps`);
  }

  /**
   * Clear all — hide cursor and reset state.
   * Cursor DOM elements are NOT removed, just hidden.
   */
  function clearAll() {
    isActive = false;
    isPaused = false;
    arrived = false;
    currentStepState = STEP_STATE.IDLE;
    window.folloSteps = [];
    window.folloCurrentStep = 0;

    if (cursorEl) cursorEl.classList.remove('active', 'arrived', 'paused');
    hideLabel();
    hideHighlight();
    hideBadge();

    // Move cursor off-screen
    currentX = -100;
    currentY = -100;
    setCursorPos(-100, -100);

    emitState();
  }


  // ══════════════════════════════════════════
  //  LEGACY COMPAT
  // ══════════════════════════════════════════

  function onGuideStateChange(callback) {
    onStateChange = callback;
  }

  function getState() {
    return {
      isRunning: isActive,
      isPaused,
      currentStep: window.folloCurrentStep,
      totalSteps: window.folloSteps.length,
    };
  }


  // ══════════════════════════════════════════
  //  v3: startGuidance — entry point from EXECUTE_GUIDANCE
  // ══════════════════════════════════════════

  /**
   * Start guidance from an array of resolved steps (sent by service worker).
   * Creates a StepQueue, populates it, starts passive tracking, and kicks off
   * the rAF cursor loop.
   *
   * @param {Array} steps — resolved step objects from executeGuidancePipeline
   */
  function startGuidance(steps) {
    if (!steps || !steps.length) return;

    console.log(`[FolloMe] startGuidance called with ${steps.length} steps`);

    // Activate
    isActive = true;
    isPaused = false;

    // Create and populate StepQueue
    if (typeof StepQueue !== 'undefined') {
      stepQueue = new StepQueue();
      steps.forEach((s, i) => {
        stepQueue._steps[i] = { ...s, status: 'resolved', index: i };
      });
      stepQueue._resolvedUpTo = steps.length - 1;
    } else {
      // Fallback: use legacy window.folloSteps
      console.warn('[FolloMe] StepQueue class not available, using legacy mode');
      window.folloSteps = steps.map((s, i) => ({ ...s, index: i }));
      window.folloCurrentStep = 0;
    }

    // Reset TransitionEngine
    TransitionEngine.reset();
    arrived = false;

    // Ensure cursor DOM exists
    ensureCursor();
    cursorEl.classList.add('active');

    // Position cursor at starting point (top-right)
    currentX = window.innerWidth - 60;
    currentY = 80;
    setCursorPos(currentX - 10, currentY - 10);

    // Wire step completion listener
    _attachStepCompleteListener();

    // Start passive tracking (batch mode)
    if (typeof PassiveProgressTracker !== 'undefined') {
      const trackSteps = stepQueue ? stepQueue._steps : window.folloSteps;
      PassiveProgressTracker.startTracking(trackSteps, { stepQueue });
    }

    // Start the rAF loop
    requestAnimationFrame(runLoop);

    emitState();
    console.log(`[FolloMe] ✓ Guidance started: ${steps.length} steps`);
  }


  // ── Public API ──
  return {
    processResponse,
    getExplanation,
    guideTo,
    clearAll,
    parseActions,
    // Playback
    pause,
    resume,
    skip,
    replay,
    // State
    onGuideStateChange,
    getState,
    // v3: StepQueue integration
    initWithQueue,
    updateSteps,
    startGuidance,
    // v3: Engine internals (exposed for service worker / content.js integration)
    TransitionEngine,
    ConfidenceBehavior,
  };
})();

// Expose globally
if (typeof window !== 'undefined') {
  window.FolloCursorGuide = FolloCursorGuide;
}
