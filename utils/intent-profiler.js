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
   * NEW v3: Validate that the current page matches Teacher AI's guidance context.
   * Compares teacher's mentioned URL/page clues against actual page metadata.
   *
   * @param {string} teacherResponse — raw or compressed Teacher response text
   * @param {object} currentPageMeta — { url, title, domain, elements: [] }
   *   - url:      current page URL
   *   - title:    current page document.title
   *   - domain:   IntentProfiler.getDomain() result (optional, computed if missing)
   *   - elements: flattened DOM snapshot array [{ text, id, className, type, ... }]
   * @returns {{ matches: boolean, confidence: number, reasons: string[] }}
   */
  function validatePageMatch(teacherResponse, currentPageMeta) {
    const reasons = [];
    let score = 0;
    let checks = 0;

    const response = (teacherResponse || '').toLowerCase();
    const meta = currentPageMeta || {};
    const url = (meta.url || '').toLowerCase();
    const title = (meta.title || '').toLowerCase();
    const elements = meta.elements || [];

    // ── Check 1: URL keyword overlap ──
    // Extract domain-like keywords from the teacher response
    const urlPatterns = response.match(/(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/g) || [];
    for (const pattern of urlPatterns) {
      checks++;
      const cleanDomain = pattern.replace(/^(?:https?:\/\/)?(?:www\.)?/, '');
      if (url.includes(cleanDomain)) {
        score++;
        reasons.push(`URL contains '${cleanDomain}'`);
      }
    }

    // ── Check 2: Page-type clues in response ──
    const pageClues = [
      { regex: /\bsign\s*up\b/i, domCheck: () => !!elements.find(e => /sign.?up|register|create.?account/i.test(e.text || '')) },
      { regex: /\blog\s*in\b/i, domCheck: () => !!elements.find(e => /log.?in|sign.?in/i.test(e.text || '')) },
      { regex: /\bsettings?\b/i, domCheck: () => !!elements.find(e => /settings?|preferences?|account/i.test(e.text || '')) },
      { regex: /\bsearch\b/i, domCheck: () => !!elements.find(e => e.type === 'search' || /search/i.test(e.placeholder || '')) },
      { regex: /\bform\b/i, domCheck: () => elements.filter(e => /input|select|textarea/i.test(e.type || '')).length >= 2 },
      { regex: /\bcheckout\b/i, domCheck: () => !!elements.find(e => /checkout|payment|cart|order/i.test(e.text || '')) },
      { regex: /\bprofile\b/i, domCheck: () => !!elements.find(e => /profile|avatar|bio/i.test(e.text || '')) }
    ];

    for (const clue of pageClues) {
      if (clue.regex.test(response)) {
        checks++;
        if (clue.domCheck()) {
          score++;
          reasons.push(`Page has ${clue.regex.source.replace(/\\[bs]/g, '')} elements`);
        }
      }
    }

    // ── Check 3: Title alignment ──
    // Extract meaningful words from teacher response and check title
    const meaningfulWords = response
      .split(/[\s,.!?;:]+/)
      .filter(w => w.length > 4 && !/^(click|enter|type|select|should|would|could|please|first|then|next|after)$/i.test(w));

    const titleMatches = meaningfulWords.filter(w => title.includes(w));
    if (meaningfulWords.length > 0) {
      checks++;
      const titleRatio = titleMatches.length / Math.min(meaningfulWords.length, 10);
      if (titleRatio > 0.2) {
        score++;
        reasons.push(`Title matches: ${titleMatches.slice(0, 3).join(', ')}`);
      }
    }

    // ── Check 4: Element target overlap (lightweight version of old validatePageMatch) ──
    // Extract action targets from the response and check if DOM has them
    const ACTION_VERB_RX = /\b(?:click|tap|type|enter|fill|select|choose|press|check|toggle|submit)\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?([^'",.!?]{3,40})['"]?/gi;
    let targetMatch;
    const targets = [];
    while ((targetMatch = ACTION_VERB_RX.exec(response)) !== null) {
      targets.push(targetMatch[1].toLowerCase().trim());
    }

    if (targets.length > 0) {
      checks++;
      const corpus = elements.reduce((acc, el) => {
        return acc + ' ' + (el.text || '') + ' ' + (el.id || '') + ' ' + (el.className || '') +
          ' ' + (el.ariaLabel || '') + ' ' + (el.placeholder || '');
      }, '').toLowerCase();

      let targetHits = 0;
      for (const t of targets) {
        if (corpus.includes(t)) {
          targetHits++;
        } else {
          // Partial word matching
          const words = t.split(/\s+/).filter(w => w.length > 3);
          if (words.length > 0 && words.some(w => corpus.includes(w))) {
            targetHits += 0.5;
          }
        }
      }
      const targetRatio = targetHits / targets.length;
      if (targetRatio > 0.3) {
        score++;
        reasons.push(`${Math.round(targetRatio * 100)}% of instruction targets found in DOM`);
      }
    }

    // ── Compute final confidence ──
    // If no checks could be made (generic response), assume match
    if (checks === 0) {
      return { matches: true, confidence: 0.5, reasons: ['No page-specific clues in teacher response — assuming match'] };
    }

    const confidence = Math.min(score / checks, 1.0);
    return {
      matches: confidence >= 0.3,
      confidence: Math.round(confidence * 100) / 100,
      reasons
    };
  }

  /**
   * NEW v3: Generate domain-specific matching hints for Groq.
   * Tells the Groq mapper which element attributes to prioritise
   * based on the type of page being guided on.
   *
   * @param {string} domain — result of getDomain() (e.g. 'web_form', 'design_tool')
   * @returns {{ strategy: string, priorityAttributes: string[], prompt: string, fuzzyTolerance: number }}
   */
  function getMatchingStrategy(domain) {
    switch (domain) {
      case 'web_form':
        return {
          strategy: 'label_placeholder',
          priorityAttributes: ['placeholder', 'label', 'name', 'aria-label', 'type'],
          prompt: 'Match using field labels, placeholders, and input names. Prioritize exact label matches.',
          fuzzyTolerance: 0.3   // low tolerance — forms are precise
        };

      case 'design_tool':
        return {
          strategy: 'icon_tooltip',
          priorityAttributes: ['aria-label', 'title', 'tooltip', 'data-testid'],
          prompt: 'Match using toolbar tooltips, icon aria-labels, and panel headers. A screenshot is attached — use it to identify visual tools.',
          fuzzyTolerance: 0.6   // high tolerance — icon-only UIs are ambiguous
        };

      case 'dashboard':
        return {
          strategy: 'section_heading',
          priorityAttributes: ['text', 'aria-label', 'title', 'class'],
          prompt: 'Match using section headings, chart titles, and table headers. Elements may be dynamically rendered — look for closest semantic match.',
          fuzzyTolerance: 0.5
        };

      case 'code_editor':
        return {
          strategy: 'tab_label',
          priorityAttributes: ['aria-label', 'title', 'text', 'class'],
          prompt: 'Match using tab names, file tree labels, and toolbar text. Buttons may use icon-only labels — check aria-label and title attributes.',
          fuzzyTolerance: 0.4
        };

      case 'generic_ui':
      default:
        return {
          strategy: 'text_first',
          priorityAttributes: ['text', 'aria-label', 'placeholder', 'title', 'name'],
          prompt: 'Match using visible text content first, then aria-labels and titles. Use semantic similarity for ambiguous matches.',
          fuzzyTolerance: 0.4
        };
    }
  }

  /**
   * NEW v3: Heuristic check — is the teacher's guidance relevant to this page?
   * Lightweight pre-filter that runs BEFORE the full validatePageMatch.
   * Uses only the query text, URL, and page title (no DOM scan).
   *
   * @param {string} teacherQuery — what the user originally asked the Teacher AI
   * @param {string} pageURL — current page URL
   * @param {string} pageTitle — current document.title
   * @returns {boolean} true if the page is likely relevant to the query
   */
  function isRelevantPage(teacherQuery, pageURL, pageTitle) {
    if (!teacherQuery) return true; // no query context → can't filter, assume relevant

    const query = teacherQuery.toLowerCase();
    const url = (pageURL || '').toLowerCase();
    const title = (pageTitle || '').toLowerCase();

    // Extract meaningful keywords from the query (skip filler/action words)
    const SKIP_WORDS = new Set([
      ...FILLER_WORDS,
      'click', 'type', 'enter', 'select', 'fill', 'submit', 'button',
      'field', 'form', 'page', 'link', 'sign', 'create', 'new', 'account',
      'where', 'when', 'which', 'that', 'should', 'could', 'would', 'into'
    ]);

    const queryWords = query
      .split(/[\s,.!?;:'"]+/)
      .filter(w => w.length > 2 && !SKIP_WORDS.has(w));

    if (queryWords.length === 0) return true; // purely action-based query → any page could match

    // Check if any query keyword appears in URL or title
    const combined = url + ' ' + title;
    const matchCount = queryWords.filter(w => combined.includes(w)).length;
    const matchRatio = matchCount / queryWords.length;

    // At least 20% of keywords should match URL or title
    // A single keyword match is enough if there are few keywords
    if (queryWords.length <= 3) return matchCount >= 1;
    return matchRatio >= 0.2;
  }

  return {
    profile,
    validatePageMatch,
    getMatchingStrategy,
    isRelevantPage,
    // Expose internal helpers for external direct use
    getMode,
    getDomain,
    getComplexity,
    getNeedsExplanation
  };
})();

if (typeof window !== 'undefined') {
  window.IntentProfiler = IntentProfiler;
}
if (typeof self !== 'undefined') {
  self.IntentProfiler = IntentProfiler;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = IntentProfiler;
}
