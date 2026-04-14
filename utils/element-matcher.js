/**
 * FolloMe — Element Matcher
 * Fuzzy matching engine that maps AI action targets to real DOM elements.
 *
 * Input:
 *   - Structured UI elements (from ContextExtractor)
 *   - AI action targets (text descriptions or element indexes)
 *
 * Logic:
 *   - Exact index lookup (if AI returned idx)
 *   - Fuzzy text matching (Levenshtein, token overlap, n-gram)
 *   - Attribute matching (placeholder, aria-label, name, title)
 *   - Rank candidates by composite similarity score
 *
 * Output:
 *   - Best matching DOM element reference with confidence score
 */

const ElementMatcher = (() => {

  // ══════════════════════════════════════════
  //  STRING SIMILARITY ALGORITHMS
  // ══════════════════════════════════════════

  /**
   * Levenshtein distance between two strings.
   * Returns the number of single-character edits needed.
   */
  function levenshtein(a, b) {
    const an = a.length;
    const bn = b.length;
    if (an === 0) return bn;
    if (bn === 0) return an;

    // Optimize: use shorter string as inner loop
    if (an > bn) return levenshtein(b, a);

    let prev = Array.from({ length: an + 1 }, (_, i) => i);
    let curr = new Array(an + 1);

    for (let j = 1; j <= bn; j++) {
      curr[0] = j;
      for (let i = 1; i <= an; i++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[i] = Math.min(
          prev[i] + 1,      // deletion
          curr[i - 1] + 1,  // insertion
          prev[i - 1] + cost // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[an];
  }

  /**
   * Normalized Levenshtein similarity (0–1, where 1 = exact match)
   */
  function levenshteinSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const la = a.toLowerCase().trim();
    const lb = b.toLowerCase().trim();
    if (la === lb) return 1;
    const maxLen = Math.max(la.length, lb.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(la, lb) / maxLen;
  }

  /**
   * Token overlap score (0–1).
   * Splits strings into words and measures Jaccard-like overlap.
   */
  function tokenOverlap(a, b) {
    if (!a || !b) return 0;

    const tokensA = new Set(
      a.toLowerCase().trim().split(/[\s\-_.,;:!?'"()\[\]{}]+/).filter(t => t.length > 1)
    );
    const tokensB = new Set(
      b.toLowerCase().trim().split(/[\s\-_.,;:!?'"()\[\]{}]+/).filter(t => t.length > 1)
    );

    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }

    // Jaccard similarity
    const union = new Set([...tokensA, ...tokensB]).size;
    return union > 0 ? overlap / union : 0;
  }

  /**
   * Substring containment score (0–1).
   * Returns 1 if one string fully contains the other.
   */
  function containmentScore(a, b) {
    if (!a || !b) return 0;
    const la = a.toLowerCase().trim();
    const lb = b.toLowerCase().trim();

    if (la.includes(lb)) return lb.length / la.length;
    if (lb.includes(la)) return la.length / lb.length;
    return 0;
  }

  /**
   * Bigram similarity (character-level n-grams).
   * Good for catching typos and partial matches.
   */
  function bigramSimilarity(a, b) {
    if (!a || !b) return 0;
    const la = a.toLowerCase().trim();
    const lb = b.toLowerCase().trim();

    if (la.length < 2 || lb.length < 2) return la === lb ? 1 : 0;

    const bigramsA = new Set();
    const bigramsB = new Set();

    for (let i = 0; i < la.length - 1; i++) bigramsA.add(la.substring(i, i + 2));
    for (let i = 0; i < lb.length - 1; i++) bigramsB.add(lb.substring(i, i + 2));

    let overlap = 0;
    for (const bg of bigramsA) {
      if (bigramsB.has(bg)) overlap++;
    }

    const union = new Set([...bigramsA, ...bigramsB]).size;
    return union > 0 ? overlap / union : 0;
  }

  /**
   * Composite text similarity — weighted blend of all methods.
   * Returns 0–100 score.
   */
  function textSimilarity(query, candidate) {
    if (!query || !candidate) return 0;

    const lev = levenshteinSimilarity(query, candidate);
    const tok = tokenOverlap(query, candidate);
    const con = containmentScore(query, candidate);
    const big = bigramSimilarity(query, candidate);

    // Weighted combination (Levenshtein is most reliable for short strings,
    // token overlap for longer descriptions)
    const queryLen = query.length;
    let score;

    if (queryLen < 15) {
      // Short queries: favor Levenshtein and containment
      score = lev * 40 + con * 30 + big * 20 + tok * 10;
    } else {
      // Longer queries: favor token overlap
      score = tok * 35 + con * 25 + lev * 25 + big * 15;
    }

    return Math.round(Math.min(score, 100));
  }

  // ══════════════════════════════════════════
  //  ELEMENT SCORING
  // ══════════════════════════════════════════

  /**
   * Score a UI element against an action target description.
   *
   * @param {Object} uiEl - Structured UI element from ContextExtractor
   * @param {string} targetDesc - AI's text description of the target
   * @param {string} actionType - The action (click, type, select, etc.)
   * @returns {{ score: number, reasons: string[], matchField: string }}
   */
  function scoreUIElement(uiEl, targetDesc, actionType) {
    if (!targetDesc) return { score: 0, reasons: ['empty target'], matchField: '' };

    let bestScore = 0;
    let bestField = '';
    const reasons = [];
    const desc = targetDesc.toLowerCase().trim();

    // ── Match against each field ──
    const fields = [
      { key: 'text',        value: uiEl.text,        weight: 1.0 },
      { key: 'ariaLabel',   value: uiEl.ariaLabel,   weight: 0.95 },
      { key: 'placeholder', value: uiEl.placeholder,  weight: 0.9 },
      { key: 'label',       value: uiEl.label,        weight: 0.9 },
      { key: 'title',       value: uiEl.title,        weight: 0.8 },
      { key: 'name',        value: uiEl.name,         weight: 0.7 },
      { key: 'domId',       value: uiEl.domId,        weight: 0.6 },
    ];

    for (const { key, value, weight } of fields) {
      if (!value) continue;

      const sim = textSimilarity(desc, value);
      const weighted = Math.round(sim * weight);

      if (weighted > bestScore) {
        bestScore = weighted;
        bestField = key;
      }

      if (weighted > 30) {
        reasons.push(`${key}: ${Math.round(sim)}%`);
      }
    }

    // ── Type affinity bonus ──
    // If the action implies a specific element type, boost elements of that type
    const typeAffinity = {
      click:  ['button', 'link', 'clickable', 'tab', 'checkbox', 'radio', 'toggle', 'menu_item'],
      type:   ['input', 'textarea', 'search'],
      select: ['dropdown', 'radio', 'checkbox', 'toggle'],
      scroll: [],
      focus:  [],
      hover:  ['button', 'link', 'clickable'],
      toggle: ['checkbox', 'toggle', 'switch'],
    };

    const affinityTypes = typeAffinity[actionType] || [];
    if (affinityTypes.includes(uiEl.type)) {
      bestScore = Math.min(bestScore + 10, 100);
      reasons.push('type match');
    }

    // ── Penalty for disabled elements ──
    if (uiEl.disabled) {
      bestScore = Math.max(bestScore - 20, 0);
      reasons.push('disabled');
    }

    // ── Visibility bonus ──
    // Prefer elements that are fully in viewport
    const inViewport = uiEl.y >= 0 && (uiEl.y + uiEl.height) <= window.innerHeight;
    if (inViewport && bestScore > 0) {
      bestScore = Math.min(bestScore + 3, 100);
    }

    // ── Size reasonableness ──
    if (uiEl.width >= 20 && uiEl.width <= 600 && uiEl.height >= 16 && uiEl.height <= 300) {
      if (bestScore > 0) bestScore = Math.min(bestScore + 2, 100);
    }

    return { score: bestScore, reasons, matchField: bestField };
  }

  // ══════════════════════════════════════════
  //  MAIN MATCHING API
  // ══════════════════════════════════════════

  /**
   * Find the best matching element for an AI action.
   *
   * @param {Object} action - Parsed action: { action, target, idx?, value? }
   * @param {Array} uiElements - Structured UI elements from ContextExtractor
   * @returns {{ element: HTMLElement|null, score: number, confidence: string, reasons: string[], candidates: Array }}
   */
  function matchAction(action, uiElements) {
    if (!uiElements || uiElements.length === 0) {
      return { element: null, score: 0, confidence: 'none', reasons: ['no UI elements'], candidates: [] };
    }

    // ── Strategy 1: Direct index lookup (most reliable) ──
    if (action.idx !== undefined && action.idx !== null) {
      const indexed = uiElements.find(el => el._idx === action.idx);
      if (indexed && indexed._el) {
        return {
          element: indexed._el,
          score: 95,
          confidence: 'high',
          reasons: ['direct index match'],
          candidates: [{ element: indexed._el, score: 95, reasons: ['idx reference'] }],
        };
      }
    }

    // ── Strategy 2: Fuzzy text matching ──
    const target = action.target || action.description || '';
    if (!target) {
      return { element: null, score: 0, confidence: 'none', reasons: ['empty target'], candidates: [] };
    }

    const scored = uiElements
      .map(uiEl => {
        const result = scoreUIElement(uiEl, target, action.action);
        return {
          element: uiEl._el,
          uiElement: uiEl,
          score: result.score,
          reasons: result.reasons,
          matchField: result.matchField,
        };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      return { element: null, score: 0, confidence: 'none', reasons: ['no matches found'], candidates: [] };
    }

    const best = scored[0];
    const candidates = scored.slice(0, 3);

    // Determine confidence level
    let confidence;
    if (best.score >= 60) {
      confidence = 'high';
    } else if (best.score >= 30) {
      confidence = 'low';
    } else {
      confidence = 'none';
    }

    return {
      element: best.element,
      score: best.score,
      confidence,
      reasons: best.reasons,
      candidates,
    };
  }

  /**
   * Match multiple actions against UI elements.
   * Returns array of match results.
   */
  function matchActions(actions, uiElements) {
    return actions.map((action, i) => {
      const result = matchAction(action, uiElements);
      return {
        ...action,
        ...result,
        stepNum: action.stepNum || (actions.length > 1 ? i + 1 : null),
      };
    });
  }

  /**
   * Quick single-target match (backward compatible with cursor guide).
   * Searches the live DOM without needing pre-extracted UI elements.
   */
  function findByDescription(description, actionType = 'click') {
    if (!description) return null;

    // Extract live UI elements
    if (typeof ContextExtractor !== 'undefined') {
      const uiElements = ContextExtractor.getUIElements();
      const result = matchAction(
        { action: actionType, target: description },
        uiElements
      );
      return result.confidence !== 'none' ? result.element : null;
    }

    return null;
  }

  // ── Public API ──
  return {
    matchAction,
    matchActions,
    findByDescription,
    // Exposed for testing / direct use
    textSimilarity,
    levenshteinSimilarity,
    tokenOverlap,
    containmentScore,
    bigramSimilarity,
    scoreUIElement,
  };
})();

if (typeof window !== 'undefined') {
  window.ElementMatcher = ElementMatcher;
}
