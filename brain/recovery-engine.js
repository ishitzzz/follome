/**
 * FolloMe — Recovery Engine (Layer 6)
 * Native 3-level fallback search for missing or low-confidence nodes.
 * Prevents collapsing the macro-pipeline when minor DOM changes occur.
 */

const RecoveryEngine = (() => {
  const L1_THRESHOLD = 30; // standard semantic matcher
  
  /**
   * 3-Level Fallback Search
   */
  function recover(step) {
    if (!step || !step.target) return null;
    
    // Some steps come from Groq with < 0.4 confidence, we treat them as missing.
    // Ensure we don't spam recover on the same element that just failed L3
    if (step._recoveryAttempted) return null;
    
    step._recoveryAttempted = true; // Mark to prevent loop locks

    const targetText = step.target.toLowerCase().trim();
    console.log(`[FolloMe:Recovery] Attempting L1 recovery for "${targetText}"...`);

    // Level 1: Re-run Semantic Element Matcher natively
    if (typeof ElementMatcher !== 'undefined') {
      const result = ElementMatcher.resolveAction(step);
      if (result && result.element && result.score >= L1_THRESHOLD) {
        console.log(`[FolloMe:Recovery] L1 success via Semantic Matcher (Score: ${result.score})`);
        return result.element;
      }
    }

    console.log(`[FolloMe:Recovery] L2 fuzzy text search...`);
    // Level 2: Greedy wildcard text search on visible interactables
    const fallbacks = [
      'button', 'a', 'input', 'select', 'textarea', 
      '[role="button"]', '[role="link"]', '[tabindex]'
    ].join(', ');
    
    let bestFuzzyEl = null;

    // Use querySelectorAll and filter
    const nodes = document.querySelectorAll(fallbacks);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      
      let text = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase();
      if (text.includes(targetText) || targetText.includes(text)) {
        bestFuzzyEl = el;
        break;
      }
    }

    if (bestFuzzyEl) {
      console.log(`[FolloMe:Recovery] L2 success via Fuzzy Matcher.`);
      return bestFuzzyEl;
    }

    console.log(`[FolloMe:Recovery] L3 structural siblings search...`);
    // Level 3: Look for any visible interactive item that might match intent
    if (step.action === 'click' || step.priority === 'primary') {
      const primaries = Array.from(document.querySelectorAll('button.primary, button[type="submit"], [role="button"], input[type="submit"]'))
        .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
      
      if (primaries.length > 0) {
        console.log(`[FolloMe:Recovery] L3 success via Primary Structure Fallback.`);
        return primaries[0];
      }
    }

    console.warn(`[FolloMe:Recovery] All 3 levels failed for "${targetText}".`);
    return null;
  }

  // Bind to DOM Stability Monitor global event
  if (typeof window !== 'undefined') {
    window.addEventListener('follome-dom-unstable', () => {
      console.log('[FolloMe:Recovery] DOM Stability threshold breached. Active step re-evaluation.');
      
      // If we are currently tracking a step, try to recover it dynamically
      if (typeof window.folloSteps !== 'undefined' && typeof window.folloCurrentStep !== 'undefined') {
        const currentStep = window.folloSteps[window.folloCurrentStep];
        if (currentStep) {
           // Reset recovery flag on mass disruption so we can try again
           currentStep._recoveryAttempted = false; 
           const recovered = recover(currentStep);
           if (recovered) {
             currentStep.element = recovered;
           }
        }
      }
    });
  }

  return { recover };
})();

if (typeof window !== 'undefined') window.RecoveryEngine = RecoveryEngine;
