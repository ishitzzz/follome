/**
 * FolloMe - Intent Profiler
 * Generates a structured Intent Profile from user query and DOM structure.
 * Pure DOM + logic only (No AI).
 */

const IntentProfiler = (() => {
  const FILLER_WORDS = new Set([
    "please", "can", "you", "help", "me", "how", "do", "i", "to", "the", 
    "a", "an", "is", "what", "does", "this", "meaning", "of", "with", "would", "like"
  ]);

  /**
   * Determine the operation mode using keyword heuristics
   */
  function getMode(queryLC) {
    if (/what is this|what does this do/i.test(queryLC)) return 'inspect';
    if (/how does|learn|understand/i.test(queryLC)) return 'learn';
    if (/fill|click|create|add|run|submit/i.test(queryLC)) return 'act';
    if (/how do i|help me|guide me/i.test(queryLC)) return 'assist';
    
    // Fallback if no exact matches but indicates action
    return 'assist';
  }

  /**
   * Extract the main objective phrase by removing filler words
   */
  function getGoal(queryLC) {
    if (!queryLC) return "explore page"; // Default fallback
    
    // Split on whitespace/punctuation to find tokens
    const words = queryLC.split(/[\s,.\?]+/);
    const filtered = words.filter(w => w.length > 0 && !FILLER_WORDS.has(w));
    
    return filtered.join(' ') || "explore page";
  }

  /**
   * Determine page domain based on DOM structure heuristics
   */
  function getDomain() {
    // 1. Code-like textarea / editors
    const isCodeEditor = !!document.querySelector('.CodeMirror, .monaco-editor, pre code, [class*="editor"], textarea[class*="code"]');
    if (isCodeEditor) return 'code_editor';

    // 2. Many inputs -> web form
    const inputsCount = document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
    if (inputsCount >= 3) return 'web_form';

    // 3. Charts/tables -> dashboard
    const isDashboard = !!document.querySelector('table, [class*="chart"], [class*="graph"], [class*="dashboard"]');
    if (isDashboard) return 'dashboard';

    // 4. Canvas/svg/tools -> design tool
    const isDesignTool = !!document.querySelector('canvas, svg, [class*="toolbar"], [class*="palette"], [class*="canvas"]');
    if (isDesignTool) return 'design_tool';

    // 5. Fallback
    return 'generic_ui';
  }

  /**
   * Determine task complexity based on inputs/buttons
   */
  function getComplexity() {
    const inputsCount = document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
    const buttonsCount = document.querySelectorAll('button, input[type="submit"], input[type="button"], a[class*="btn"], [role="button"]').length;

    if (inputsCount > 1) return 'multi_step';
    
    // Single step heuristics: minimal inputs, 1 clear action button
    if (inputsCount <= 1 && buttonsCount === 1) return 'single_step';

    return 'exploratory'; // Unclear navigation
  }

  /**
   * Check if query requires explanation
   */
  function getNeedsExplanation(queryLC) {
    return /why|what is|explain|understand/i.test(queryLC);
  }

  /**
   * Generate the full Intent Profile
   */
  function profile(query) {
    const queryLC = (query || '').toLowerCase().trim();

    return {
      mode: getMode(queryLC),
      goal: getGoal(queryLC),
      domain: getDomain(),
      complexity: getComplexity(),
      needs_explanation: getNeedsExplanation(queryLC)
    };
  }

  /**
   * Validate if the AI instructions (Teacher hints) align with the live page heuristics.
   * Prevents executing steps on unrelated pages.
   * @param {Array} steps - Normalized [{ action, target, ... }] array.
   * @param {Array} snapshot - Flattened DOM elements array representing live page state.
   * @returns {number} Alignment Score (0.0 to 1.0). < 0.3 means blocked/unrelated.
   */
  function validatePageMatch(steps, snapshot) {
    if (!steps || steps.length === 0) return 0;
    if (!snapshot || snapshot.length === 0) return 0;

    let matchCount = 0;
    let totalTargetable = 0;

    // Aggregate text space of the snapshot
    const snapshotCorpus = snapshot.reduce((acc, curr) => {
      return acc + ' ' + (curr.text || '') + ' ' + (curr.id || '') + ' ' + (curr.className || '');
    }, '').toLowerCase();

    steps.forEach(step => {
      const hintPattern = (step.target || '').toLowerCase().trim();
      if (!hintPattern || hintPattern === 'unknown') return;
      
      totalTargetable++;
      
      if (snapshotCorpus.includes(hintPattern)) {
        matchCount++;
      } else {
        // Fallback to substring coverage
        const words = hintPattern.split(/\s+/).filter(w => w.length > 3);
        if (words.length > 0 && words.some(w => snapshotCorpus.includes(w))) {
          matchCount += 0.5; // Partial match gives half score
        }
      }
    });

    if (totalTargetable === 0) return 1.0; 
    return (matchCount / totalTargetable);
  }

  return {
    profile,
    validatePageMatch
  };
})();

if (typeof window !== 'undefined') {
  window.IntentProfiler = IntentProfiler;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = IntentProfiler;
}
