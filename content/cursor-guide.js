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
    document.body.appendChild(cursorEl);

    labelEl = document.createElement('div');
    labelEl.id = 'follome-cursor-label';
    document.body.appendChild(labelEl);

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
  //  rAF GUIDANCE LOOP
  //  Movement only — NO auto-completion.
  //  Steps advance ONLY via user interaction.
  // ══════════════════════════════════════════

  // ── Lookahead helper: resolve centroid of Step[N+1] without touching DOM state ──
  function resolveLookaheadCentroid() {
    const steps = window.folloSteps;
    const nextIdx = window.folloCurrentStep + 1;
    if (!steps || nextIdx >= steps.length) return null;
    const nextStep = steps[nextIdx];
    if (!nextStep || !nextStep.element || !isVisible(nextStep.element)) return null;
    const r = nextStep.element.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function runLoop(timestamp) {
    if (!isActive) return;

    requestAnimationFrame(runLoop);

    if (isPaused) return;

    // ── TRANSITION PHASE (T-4.2): fast LERP after user action, seeded from lookahead ──
    if (isTransitioning) {
      const steps = window.folloSteps;
      const stepIdx = window.folloCurrentStep;
      if (!steps || stepIdx >= steps.length) {
        isTransitioning = false;
        return;
      }
      const step = steps[stepIdx];
      if (!step || !step.element || !isVisible(step.element)) {
        isTransitioning = false;
        return;
      }
      const rect = step.element.getBoundingClientRect();
      targetX = rect.left + rect.width / 2;
      targetY = rect.top + rect.height / 2;

      currentX += (targetX - currentX) * TRANSITION_LERP_SPEED;
      currentY += (targetY - currentY) * TRANSITION_LERP_SPEED;
      setCursorPos(currentX - 10, currentY - 10);

      const dist = Math.hypot(targetX - currentX, targetY - currentY);
      if (dist < NEAR_THRESHOLD) {
        isTransitioning = false;
        // Fall through to normal GUIDING on next frame
      }
      return;
    }

    const steps = window.folloSteps;
    const stepIdx = window.folloCurrentStep;

    // All steps done — cursor stays on last target, label says "Complete"
    if (!steps || stepIdx >= steps.length) {
      if (steps && steps.length > 0) {
        showLabel('✓ Guide complete', currentX, currentY);
      }
      return;
    }

    const step = steps[stepIdx];
    if (!step) return;

    // Resolve element (re-resolve each frame so scrolled elements track)
    let el = step.element;
    if (!el || !isVisible(el) || step.confidence < 0.4) {
      // Missing, hidden, or low confidence -> Trigger T-6.2 RecoveryEngine
      if (typeof RecoveryEngine !== 'undefined') {
        const recovered = RecoveryEngine.recover(step);
        if (recovered) {
          step.element = recovered;
          el = recovered;
        } else {
          console.warn(`[FolloMe] Step ${stepIdx + 1}: Element recovery failed, skipping.`);
          advanceStep();
          return;
        }
      } else {
        console.warn(`[FolloMe] Step ${stepIdx + 1}: Element not found and RecoveryEngine missing, skipping.`);
        advanceStep();
        return;
      }
    }

    // Get element center
    const rect = el.getBoundingClientRect();
    targetX = rect.left + rect.width / 2;
    targetY = rect.top + rect.height / 2;
    targetRect = rect;

    // Scroll into view if off-screen
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // ── GUIDING LERP with lookahead bleed (T-4.2) ──
    // When arrived, gently drift exit velocity toward Step[N+1] centroid
    if (arrived && lookaheadX > 0 && lookaheadY > 0) {
      // Blend: 97% toward current target, 3% toward lookahead centroid — imperceptible drift
      const blendedTargetX = targetX * (1 - LOOKAHEAD_DRIFT) + lookaheadX * LOOKAHEAD_DRIFT;
      const blendedTargetY = targetY * (1 - LOOKAHEAD_DRIFT) + lookaheadY * LOOKAHEAD_DRIFT;
      currentX += (blendedTargetX - currentX) * LERP_SPEED;
      currentY += (blendedTargetY - currentY) * LERP_SPEED;
    } else {
      currentX += (targetX - currentX) * LERP_SPEED;
      currentY += (targetY - currentY) * LERP_SPEED;
    }
    setCursorPos(currentX - 10, currentY - 10);

    // Check arrival
    const dist = Math.hypot(targetX - currentX, targetY - currentY);

    if (dist < NEAR_THRESHOLD) {
      if (!arrived) {
        // Just arrived at target — enter GUIDING → WAITING state
        arrived = true;
        cursorEl.classList.add('arrived');
        currentStepState = STEP_STATE.WAITING;

        // ── PRE-FETCH lookahead centroid (T-4.2) ──
        const la = resolveLookaheadCentroid();
        if (la) {
          lookaheadX = la.x;
          lookaheadY = la.y;
          console.log(`[FolloMe] Lookahead pre-loaded: Step[${stepIdx + 2}] @ (${Math.round(la.x)}, ${Math.round(la.y)})`);
        } else {
          lookaheadX = -100;
          lookaheadY = -100;
        }

        // Show highlight around target
        showHighlight(rect);

        // Show step badge
        if (step.stepNum) {
          showBadge(step.stepNum, rect.left, rect.top);
        }

        // Show label with waiting indicator
        const actionLabel = ACTION_LABELS[step.action] || ACTION_LABELS.fallback;
        const waitMsg = step.explanation || actionLabel;
        const labelText = `${step.stepNum ? step.stepNum + '. ' : ''}${waitMsg}`;
        showLabel(labelText, rect.left, rect.bottom);

        console.log(`[FolloMe] Step ${stepIdx + 1} targeting: <${el.tagName.toLowerCase()}> "${step.description}"`);
        console.log(`[FolloMe] Waiting for user ${step.action}...`);
      }

      // NO dwell timer — cursor stays here until user interacts

    } else {
      // Still moving — cursor is in-flight
      if (arrived) {
        arrived = false;
        lookaheadX = -100;
        lookaheadY = -100;
        cursorEl.classList.remove('arrived');
        currentStepState = STEP_STATE.GUIDING;
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
  };
})();

// Expose globally
if (typeof window !== 'undefined') {
  window.FolloCursorGuide = FolloCursorGuide;
}
