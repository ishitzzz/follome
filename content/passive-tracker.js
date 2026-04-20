/**
 * FolloMe — Passive Progress Tracker (v3)
 *
 * Continuously monitors ALL interactive elements on the page via capture-phase
 * event listeners. When it detects the user has completed a step (even before
 * the cursor arrives), it dispatches a `follome-step-complete` custom event
 * so the cursor engine can auto-advance.
 *
 * Two modes of operation:
 *   1. startWatching(targetElement, actionType) — per-step targeting
 *   2. startTracking(steps) — batch: tracks ALL steps simultaneously
 *
 * Key design decisions:
 *   - Uses capture phase (3rd arg = true) to see events before sites stop propagation
 *   - All listeners are { passive: true } — never blocks page interactions
 *   - Dispatches `follome-step-complete` custom event on window (cursor-guide listens)
 *   - Never calls async code — runs in the FAST LAYER only
 */

const PassiveProgressTracker = (() => {

  // ── Listener state ──
  let _globalHandler = null;     // batch mode global capture handler
  let _perStepHandler = null;    // per-step mode handler
  let _watchedElement = null;    // per-step target element
  let _watchedAction = null;     // per-step expected action type

  // ── Action → event type mapping ──
  const ACTION_EVENT_MAP = {
    click:    ['click', 'mousedown'],
    tap:      ['click'],
    press:    ['click'],
    toggle:   ['click', 'change'],
    check:    ['click', 'change'],
    type:     ['input', 'keydown'],
    enter:    ['input', 'keydown'],
    fill:     ['input'],
    select:   ['change', 'click'],
    choose:   ['change', 'click'],
    focus:    ['focus', 'focusin'],
    navigate: ['click'],
    scroll:   ['scroll'],
    hover:    ['mouseenter', 'mouseover'],
    submit:   ['click', 'submit']
  };

  /**
   * Get the DOM event types to listen for based on action type.
   */
  function getEventTypes(actionType) {
    const action = (actionType || 'click').toLowerCase();
    return ACTION_EVENT_MAP[action] || ['click'];
  }


  // ═══════════════════════════════════════════
  //  PER-STEP WATCHING MODE
  //  Used by cursor-guide when cursor arrives at a step
  // ═══════════════════════════════════════════

  /**
   * Start watching a single target element for a specific action type.
   * When the action is detected, dispatches `follome-step-complete` and stops.
   *
   * @param {HTMLElement} targetElement — the DOM element to watch
   * @param {string} actionType — 'click' | 'type' | 'select' | etc.
   */
  function startWatching(targetElement, actionType) {
    // Clean up any previous per-step watcher
    stopWatching();

    if (!targetElement) return;

    _watchedElement = targetElement;
    _watchedAction = actionType;

    const requiredEvents = getEventTypes(actionType);

    _perStepHandler = (event) => {
      const target = event.target;

      // Direct match or child-of-expected match
      const isTargetMatch = target === _watchedElement || _watchedElement.contains(target);
      if (!isTargetMatch) return;

      // Verify the event type is relevant to the expected action
      const eventType = event.type;
      const isActionMatch = requiredEvents.includes(eventType) ||
        // Fallback: 'click' events match most actions
        eventType === 'click';

      if (!isActionMatch) return;

      // Additional validation for 'type' actions — require at least some input
      if (_watchedAction === 'type' || _watchedAction === 'enter' || _watchedAction === 'fill') {
        if (eventType === 'input') {
          const val = _watchedElement.value || _watchedElement.textContent || '';
          if (val.trim().length === 0) return; // no content yet, don't advance
        }
      }

      console.log(`[FolloMe:PassiveTracker] Step interaction detected: ${eventType} on <${target.tagName.toLowerCase()}>`);

      // Dispatch completion event
      window.dispatchEvent(new CustomEvent('follome-step-complete', {
        detail: {
          element: _watchedElement,
          action: _watchedAction,
          eventType: eventType,
          timestamp: Date.now()
        }
      }));

      // Auto-stop after completion
      stopWatching();
    };

    // Attach capture-phase listeners for all relevant event types
    const allEvents = new Set([...requiredEvents, 'click']); // always include click as fallback
    for (const evt of allEvents) {
      document.addEventListener(evt, _perStepHandler, { capture: true, passive: true });
    }

    console.log(`[FolloMe:PassiveTracker] Watching <${targetElement.tagName.toLowerCase()}> for "${actionType}" (events: ${[...allEvents].join(', ')})`);
  }

  /**
   * Stop watching the current per-step target.
   */
  function stopWatching() {
    if (_perStepHandler) {
      // Remove from all possible event types
      const allEventTypes = ['click', 'mousedown', 'input', 'keydown', 'change',
        'focus', 'focusin', 'scroll', 'mouseenter', 'mouseover', 'submit'];
      for (const evt of allEventTypes) {
        document.removeEventListener(evt, _perStepHandler, { capture: true });
      }
      _perStepHandler = null;
    }
    _watchedElement = null;
    _watchedAction = null;
  }


  // ═══════════════════════════════════════════
  //  BATCH TRACKING MODE (v3)
  //  Tracks ALL steps simultaneously with a single global listener set
  // ═══════════════════════════════════════════

  /**
   * Start tracking ALL steps simultaneously (not just the current one).
   * Called once when guidance starts, tracks the entire step list.
   * Uses a StepQueue reference and resolveElement from cursor-guide.
   *
   * @param {Array} steps — full step array from StepQueue
   * @param {object} [options] — { stepQueue, resolveElement }
   */
  function startTracking(steps, options) {
    stopTracking();

    if (!steps || steps.length === 0) return;

    const queue = options?.stepQueue || (typeof window !== 'undefined' ? window._folloStepQueue : null);

    _globalHandler = (event) => {
      const target = event.target;
      const startIdx = queue ? queue._activeStep : (window.folloCurrentStep || 0);

      for (let i = startIdx; i < steps.length; i++) {
        const step = steps[i];
        if (!step || step.status === 'completed' || step.status === 'skipped_by_user') continue;
        if (step.status !== 'resolved') continue;

        // Resolve element — try direct ref, then selector, then idx
        let el = step.element || step._el;
        if (!el && step.elementSelector) {
          try { el = document.querySelector(step.elementSelector); } catch {}
        }
        if (!el) continue;

        // Did the user interact with THIS step's element?
        if (el === target || el.contains(target)) {
          _handleBatchInteraction(i, step, el, event, steps, queue);
        }
      }
    };

    // Capture phase — catches ALL clicks, inputs, changes before bubbling
    document.addEventListener('click', _globalHandler, { capture: true, passive: true });
    document.addEventListener('input', _globalHandler, { capture: true, passive: true });
    document.addEventListener('change', _globalHandler, { capture: true, passive: true });
    document.addEventListener('focus', _globalHandler, { capture: true, passive: true });

    console.log(`[FolloMe:PassiveTracker] Batch tracking started for ${steps.length} steps`);
  }

  /**
   * Handle a detected interaction in batch mode.
   * Validates completion and dispatches events.
   */
  function _handleBatchInteraction(stepIndex, step, el, event, steps, queue) {
    // Don't re-process completed steps
    if (step.status === 'completed') return;

    // Validate the event type matches the step action
    const requiredEvents = getEventTypes(step.action);
    if (!requiredEvents.includes(event.type) && event.type !== 'click') return;

    // Additional validation for type/fill actions
    if (step.action === 'type' || step.action === 'enter' || step.action === 'fill') {
      if (event.type === 'input') {
        const val = el.value || el.textContent || '';
        if (val.trim().length === 0) return;
      }
    }

    console.log(`[FolloMe:PassiveTracker] Batch: Step ${stepIndex + 1} interaction detected (${event.type})`);

    // Mark step as completed
    step.status = 'completed';
    step.completedAt = Date.now();

    // If user completed a FUTURE step (skipped ahead), mark intermediates
    if (queue && stepIndex > queue._activeStep) {
      while (queue._activeStep < stepIndex) {
        const skippedStep = queue._steps[queue._activeStep];
        if (skippedStep) skippedStep.status = 'skipped_by_user';
        queue.advance();
      }
    }

    // Dispatch completion event (cursor-guide listens)
    window.dispatchEvent(new CustomEvent('follome-step-complete', {
      detail: {
        stepIndex,
        element: el,
        action: step.action,
        eventType: event.type,
        timestamp: Date.now(),
        batchMode: true
      }
    }));
  }

  /**
   * Stop all batch tracking.
   */
  function stopTracking() {
    if (_globalHandler) {
      document.removeEventListener('click', _globalHandler, { capture: true });
      document.removeEventListener('input', _globalHandler, { capture: true });
      document.removeEventListener('change', _globalHandler, { capture: true });
      document.removeEventListener('focus', _globalHandler, { capture: true });
      _globalHandler = null;
    }
  }


  // ═══════════════════════════════════════════
  //  LEGACY COMPAT: auto-init global listeners
  //  (from v2 — kept so manifest content_scripts still work)
  // ═══════════════════════════════════════════

  let _legacyInitialized = false;

  function init() {
    if (_legacyInitialized) return;

    const legacyHandler = (event) => {
      // Only track if guidance is active (legacy window.folloSteps)
      if (typeof FolloCursorGuide === 'undefined' || !FolloCursorGuide.getState().isRunning) return;

      const currentStepNum = window.folloCurrentStep;
      const steps = window.folloSteps;
      if (!steps || currentStepNum >= steps.length) return;

      const step = steps[currentStepNum];
      if (!step || !step.element) return;

      const target = event.target;
      const expectedElement = step.element;

      // Direct match or child-of-expected match
      const isTargetMatch = target === expectedElement || expectedElement.contains(target);
      if (!isTargetMatch) return;

      // Verify event type matches action
      const requiredEvents = getEventTypes(step.action);
      if (!requiredEvents.includes(event.type) && event.type !== 'click') return;

      console.log(`[FolloMe:PassiveTracker] Legacy: detected interaction for Step ${currentStepNum + 1}`);

      window.dispatchEvent(new CustomEvent('follome-step-complete', {
        detail: {
          stepIndex: currentStepNum,
          element: expectedElement,
          action: step.action,
          eventType: event.type,
          timestamp: Date.now(),
          batchMode: false
        }
      }));
    };

    window.addEventListener('click', legacyHandler, { capture: true, passive: true });
    window.addEventListener('change', legacyHandler, { capture: true, passive: true });
    window.addEventListener('input', legacyHandler, { capture: true, passive: true });
    window.addEventListener('focus', legacyHandler, { capture: true, passive: true });

    _legacyInitialized = true;
    console.log('[FolloMe:PassiveTracker] Legacy global capture listeners initialized');
  }


  // ── Public API ──
  return {
    // v3: per-step watching
    startWatching,
    stopWatching,
    // v3: batch tracking
    startTracking,
    stopTracking,
    // Legacy
    init
  };
})();

// Auto-init legacy mode when loaded as content script
if (typeof window !== 'undefined') {
  window.PassiveProgressTracker = PassiveProgressTracker;
  PassiveProgressTracker.init();
}
