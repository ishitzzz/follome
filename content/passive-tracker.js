/**
 * FolloMe — Passive Progress Tracker (Layer 5)
 * Silently monitors user interactions in the capture phase to advance guidance.
 */

const PassiveProgressTracker = (() => {
  let isInitialized = false;

  const ACTIONS_MAP = {
    'click': ['click', 'mousedown', 'mouseup', 'tap', 'press', 'toggle', 'hover'],
    'change': ['select', 'change', 'blur'],
    'focus': ['focus', 'navigate', 'go to']
  };

  /**
   * Check if the event target matches the expected element for the current step.
   */
  function handleNativeEvent(event) {
    // Only track if guidance is active
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
    
    // Verify if the event type matches the required action type
    const eventType = event.type;
    let isActionMatch = false;

    if (eventType === 'click') {
      isActionMatch = ACTIONS_MAP.click.includes(step.action);
    } else if (eventType === 'change' || eventType === 'input') {
      isActionMatch = ACTIONS_MAP.change.includes(step.action) || step.action === 'type';
    } else if (eventType === 'focus' || eventType === 'focusin') {
      isActionMatch = ACTIONS_MAP.focus.includes(step.action);
    }

    if (isTargetMatch && isActionMatch) {
      console.log(`[FolloMe:PassiveTracker] Detected valid interaction for Step ${currentStepNum + 1}: ${eventType}`);
      
      // Advance the guide. Since we are in capture phase, we let the event continue to the page.
      // Small delay ensures the page's own logic (like navigation) has a chance to start
      // but our UI updates immediately.
      setTimeout(() => {
        if (typeof FolloCursorGuide !== 'undefined') {
          FolloCursorGuide.skip(); // 'skip' in cursor-guide advances the step
        }
      }, 50);
    }
  }

  function init() {
    if (isInitialized) return;

    console.log('[FolloMe:PassiveTracker] Initializing global capture listeners...');
    
    // Use capture phase (true) to ensure we see events even if the site stops propagation
    window.addEventListener('click', handleNativeEvent, { capture: true, passive: true });
    window.addEventListener('change', handleNativeEvent, { capture: true, passive: true });
    window.addEventListener('input', handleNativeEvent, { capture: true, passive: true });
    window.addEventListener('focus', handleNativeEvent, { capture: true, passive: true });

    isInitialized = true;
  }

  return { init };
})();

// Auto-init when loaded
if (typeof window !== 'undefined') {
  PassiveProgressTracker.init();
}
