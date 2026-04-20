/**
 * FolloMe — Step Normalizer + Context Compressor (v3)
 * 
 * Two exported modules:
 *   ContextCompressor — Three-stage pipeline that strips noise from raw
 *                       Teacher AI output before any normalisation runs.
 *   StepNormalizer    — Converts compressed (or raw) text into actionable
 *                       StepSequence[] objects, resolves vague instructions,
 *                       detects actions, field groups, and position hints.
 *
 * Both are consumed by the Service Worker (ES module import) and, when loaded
 * as a content script, are attached to `self` / `window`.
 */

// ───────────────────────────────────────────────────────────────────────
//  Shared constants
// ───────────────────────────────────────────────────────────────────────

const ACTION_VERBS = [
  'click', 'tap', 'press', 'type', 'enter', 'fill', 'select', 'choose',
  'check', 'toggle', 'submit', 'navigate', 'go to', 'open', 'close',
  'expand', 'collapse', 'scroll', 'drag', 'upload', 'download',
  'search', 'find', 'look for', 'locate', 'hover', 'focus', 'wait'
];

const ACTION_VERB_REGEX = new RegExp(
  '\\b(' + ACTION_VERBS.join('|') + ')\\b', 'i'
);

const STEP_PREFIX = /^(?:\d+[.)]\s*|[-•*]\s*|step\s*\d+[.:]?\s*)/i;

// ───────────────────────────────────────────────────────────────────────
//  Context Compressor  (Gap 5)
// ───────────────────────────────────────────────────────────────────────

const ContextCompressor = {

  /**
   * Three-stage compression: Strip → Extract → Compact
   * Input:  500+ word teacher response
   * Output: 50-150 word actionable core
   */
  compress(rawTeacherResponse) {
    if (!rawTeacherResponse || typeof rawTeacherResponse !== 'string') {
      return {
        steps: [],
        explanation: '',
        originalLength: 0,
        compressedLength: 0,
        compressionRatio: 1
      };
    }

    let text = rawTeacherResponse;

    // ═══ STAGE 1: STRIP — remove noise patterns ═══
    text = this._stripNoise(text);

    // ═══ STAGE 2: EXTRACT — pull out only actionable lines ═══
    const { actionableLines, explanationLines } = this._extractActionable(text);

    // ═══ STAGE 3: COMPACT — reduce each line to minimal form ═══
    const compactedSteps = actionableLines.map(line => this._compactLine(line));

    return {
      steps: compactedSteps,                              // goes to Groq
      explanation: explanationLines.join(' ').trim(),      // goes to overlay
      originalLength: rawTeacherResponse.length,
      compressedLength: compactedSteps.join(' ').length,
      compressionRatio: rawTeacherResponse.length > 0
        ? compactedSteps.join(' ').length / rawTeacherResponse.length
        : 1
    };
  },

  /**
   * STAGE 1: Strip noise — regex-based, zero AI cost.
   * Removes: disclaimers, examples, markdown formatting, pleasantries.
   */
  _stripNoise(text) {
    return text
      // Remove common AI preamble/postamble
      .replace(/^(Sure!?|Of course!?|Certainly!?|Great question!?|Here'?s? (?:how|what).*?:)\s*/gim, '')
      .replace(/(?:I hope this helps|Let me know if|Feel free to|Good luck|Happy to help).*$/gim, '')
      // Remove disclaimers
      .replace(/(?:Note:|Disclaimer:|Important:|⚠️|💡|📝).*$/gim, '')
      // Remove example blocks (```...```)
      .replace(/```[\s\S]*?```/g, '')
      // Remove markdown emphasis that adds no info
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      // Remove parenthetical asides longer than 40 chars
      .replace(/\([^)]{40,}\)/g, '')
      // Remove "For example, ..." sentences
      .replace(/(?:for example|e\.g\.|such as|like for instance)[^.]*\./gi, '')
      // Collapse whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },

  /**
   * STAGE 2: Extract actionable lines.
   * Heuristic: lines with action verbs + targets are actionable.
   * Lines without = explanation (kept separately for overlay).
   */
  _extractActionable(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const actionableLines = [];
    const explanationLines = [];

    for (const line of lines) {
      const hasActionVerb = ACTION_VERB_REGEX.test(line);
      const hasStepPrefix = STEP_PREFIX.test(line);

      if (hasStepPrefix || hasActionVerb) {
        // Strip the prefix and keep the instruction
        const cleaned = line.replace(STEP_PREFIX, '').trim();
        if (cleaned.length >= 5 && cleaned.length <= 200) {
          actionableLines.push(cleaned);
        }
      } else {
        // Line is explanation/context
        if (line.length > 10) { // skip tiny fragments
          explanationLines.push(line);
        }
      }
    }

    return { actionableLines, explanationLines };
  },

  /**
   * STAGE 3: Compact each line — remove filler, keep action + target.
   * "First, you'll want to click on the blue 'Submit' button at the bottom"
   * → "click Submit button"
   */
  _compactLine(line) {
    return line
      // Remove ordinal/position fillers
      .replace(/\b(first|next|then|after that|finally|lastly|now|also)\b[,.]?\s*/gi, '')
      // Remove hedge words
      .replace(/\b(you'll want to|you should|you need to|you can|try to|make sure to|go ahead and|please)\b\s*/gi, '')
      // Remove position descriptions (these are for the human, Groq uses DOM position)
      .replace(/\b(at the (?:top|bottom|left|right|center)(?:\s+of\s+the\s+page)?)\b/gi, '')
      // Remove color descriptions (Groq matches by text/type, not color)
      .replace(/\b(the\s+)?(blue|red|green|gray|white|black|orange|purple)\b\s*/gi, '')
      // Remove articles before targets
      .replace(/\b(the|a|an)\s+(?=\w)/gi, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }
};


// ───────────────────────────────────────────────────────────────────────
//  Position Hint Extraction  (Gap 4)
// ───────────────────────────────────────────────────────────────────────

const POSITION_PATTERNS = [
  { regex: /\b(?:in|at|on)\s+(?:the\s+)?(top[- ]?(?:left|right|center)?(?:\s+(?:corner|bar|toolbar|menu|nav))?)/i, region: '$1' },
  { regex: /\b(?:in|at|on)\s+(?:the\s+)?(bottom[- ]?(?:left|right|center)?(?:\s+(?:bar|toolbar|footer))?)/i, region: '$1' },
  { regex: /\b(?:in|at|on)\s+(?:the\s+)?(left[- ]?(?:side)?(?:\s+(?:panel|sidebar|menu))?)/i, region: '$1' },
  { regex: /\b(?:in|at|on)\s+(?:the\s+)?(right[- ]?(?:side)?(?:\s+(?:panel|sidebar))?)/i, region: '$1' },
  { regex: /\b(?:in|at|on)\s+(?:the\s+)?(center|middle)/i, region: '$1' },
  { regex: /\b(?:the\s+)?(\w+)\s+(?:button|icon|tool)\s+(?:from|in)\s+(?:the\s+)?(toolbar|menu|nav|sidebar)/i, region: '$2' },
  { regex: /\b(first|second|third|fourth|fifth|last)\s+(?:button|item|option|tab|field)/i, ordinal: '$1' }
];


// ───────────────────────────────────────────────────────────────────────
//  Fallback action detection patterns (v2 carry-over, enhanced)
// ───────────────────────────────────────────────────────────────────────

const DETECT_PATTERNS = [
  // click / tap / press
  {
    regex: /\b(?:click|tap|press|hit)\s+(?:on\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?(?:\s+(?:button|link|icon|tab|menu|field))?(?:\s*$|[.,;!])/i,
    action: 'click'
  },
  // type / enter / fill
  {
    regex: /\b(?:type|enter|input|write|fill\s+in)\s+['"]?(.+?)['"]?\s+(?:in(?:to)?|on)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?/i,
    action: 'type'
  },
  // select / choose / pick
  {
    regex: /\b(?:select|choose|pick)\s+['"]?(.+?)['"]?\s+(?:from|in)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?/i,
    action: 'select'
  },
  // scroll
  {
    regex: /\b(?:scroll)\s+(?:down|up|to)?\s*(?:the\s+|a\s+)?['"]?(.+?)['"]?/i,
    action: 'scroll'
  },
  // navigate / go to / open
  {
    regex: /\b(?:navigate|go)\s+to\s+['"]?(.+?)['"]?/i,
    action: 'navigate'
  },
  // hover
  {
    regex: /\b(?:hover)\s+(?:over\s+)?(?:the\s+|a\s+)?['"]?(.+?)['"]?/i,
    action: 'hover'
  },
  // toggle / check / uncheck
  {
    regex: /\b(?:toggle|check|uncheck)\s+(?:the\s+|a\s+)?['"]?(.+?)['"]?/i,
    action: 'toggle'
  }
];


// ───────────────────────────────────────────────────────────────────────
//  Step Normalizer  (Component Spec + Gap 4)
// ───────────────────────────────────────────────────────────────────────

const StepNormalizer = {

  /**
   * Parse raw teacher text into clean, actionable steps.
   * Handles: numbered, bulleted, conversational, mixed formats.
   *
   * Runs the ContextCompressor first to strip noise, then converts
   * each compacted line into a structured StepSequence object.
   *
   * @param {string} rawTeacherResponse — full text from Teacher AI
   * @returns {StepSequence[]} Array of { instruction, action, target, value?, positionHint?, hint }
   */
  normalize(rawTeacherResponse) {
    if (!rawTeacherResponse) return [];

    // 1. Try JSON extraction first (structured output from Teacher)
    const jsonSteps = this._extractJSON(rawTeacherResponse);
    if (jsonSteps && jsonSteps.length > 0) {
      return jsonSteps.map(obj => this._normalizeJsonStep(obj));
    }

    // 2. Run context compressor to get clean actionable lines
    const compressed = ContextCompressor.compress(rawTeacherResponse);

    if (compressed.steps.length === 0) return [];

    // 3. Convert each compacted line into a StepSequence
    return compressed.steps.map((line, i) => {
      const detected = this.detectAction(line);
      const positionHint = extractPositionHint(line);

      return {
        index: i,
        instruction: line,
        action: detected.action,
        target: detected.target,
        value: detected.value || undefined,
        positionHint: positionHint,
        hint: line,
        status: 'pending'
      };
    });
  },

  /**
   * Resolve vague instructions using conversation context.
   * "continue" → looks at last step + page state to infer next action
   * "next"     → advances to the next logical UI element
   * "do the same" → repeats previous action pattern
   *
   * @param {string} instruction — the vague instruction text
   * @param {object} conversationContext — { lastStep, previousSteps, teacherQuery }
   * @param {object} pageState — { currentElements, lastCompletedIdx }
   * @returns {string} resolved concrete instruction
   */
  resolveVague(instruction, conversationContext, pageState) {
    const lc = (instruction || '').toLowerCase().trim();
    const ctx = conversationContext || {};
    const page = pageState || {};

    // Pattern: "continue" / "keep going" / "continue where you left off"
    if (/\b(continue|keep going|carry on|go on|resume)\b/i.test(lc)) {
      if (ctx.lastStep && page.currentElements) {
        const lastIdx = ctx.lastStep.elementIdx ?? page.lastCompletedIdx ?? -1;
        // Find the next interactive element after the last completed one
        const nextEl = (page.currentElements || []).find(el =>
          (el.idx || el._idx || 0) > lastIdx
        );
        if (nextEl) {
          const elDesc = nextEl.text || nextEl.ariaLabel || nextEl.placeholder || nextEl.type || 'next element';
          const action = nextEl.type === 'input' || nextEl.type === 'textarea' ? 'type in' : 'click';
          return `${action} ${elDesc}`;
        }
      }
      return 'proceed to the next field or button';
    }

    // Pattern: "next" / "next one" / "the next field"
    if (/\b(next|next one|next field|next step|move on)\b/i.test(lc)) {
      if (ctx.lastStep) {
        const lastAction = ctx.lastStep.action || 'click';
        const lastIdx = ctx.lastStep.elementIdx ?? page.lastCompletedIdx ?? -1;
        const nextEl = (page.currentElements || []).find(el =>
          (el.idx || el._idx || 0) > lastIdx
        );
        if (nextEl) {
          const elDesc = nextEl.text || nextEl.ariaLabel || nextEl.placeholder || 'next element';
          return `${lastAction} ${elDesc}`;
        }
      }
      return 'interact with the next element';
    }

    // Pattern: "do the same" / "repeat" / "same thing" / "do it again"
    if (/\b(do the same|same thing|repeat|do it again|same as before)\b/i.test(lc)) {
      if (ctx.lastStep) {
        return ctx.lastStep.instruction || `${ctx.lastStep.action || 'click'} ${ctx.lastStep.target || 'element'}`;
      }
      return 'repeat the previous action';
    }

    // Pattern: "do it" / "go ahead" / "yes" (confirmation of a suggestion)
    if (/^(do it|go ahead|yes|yeah|yep|ok|okay|sure|confirm)$/i.test(lc)) {
      if (ctx.lastStep) {
        return ctx.lastStep.instruction || `${ctx.lastStep.action || 'click'} ${ctx.lastStep.target || 'element'}`;
      }
      return instruction; // can't resolve without context
    }

    // Not vague — return as-is
    return instruction;
  },

  /**
   * Separate explanation text from actionable steps.
   * Returns: { explanation: string, steps: StepSequence[] }
   *
   * @param {string} rawText — full teacher response
   * @returns {{ explanation: string, steps: StepSequence[] }}
   */
  splitExplanationAndSteps(rawText) {
    if (!rawText) return { explanation: '', steps: [] };

    const compressed = ContextCompressor.compress(rawText);

    const steps = compressed.steps.map((line, i) => {
      const detected = this.detectAction(line);
      const positionHint = extractPositionHint(line);

      return {
        index: i,
        instruction: line,
        action: detected.action,
        target: detected.target,
        value: detected.value || undefined,
        positionHint: positionHint,
        hint: line,
        status: 'pending'
      };
    });

    return {
      explanation: compressed.explanation,
      steps
    };
  },

  /**
   * Detect action type from natural language instruction.
   *
   * "Enter your email"                     → { action: "type", target: "email" }
   * "Click the blue button"                → { action: "click", target: "blue button" }
   * "Select 'Male' from the dropdown"      → { action: "select", target: "dropdown", value: "Male" }
   *
   * @param {string} instruction — a single instruction line
   * @returns {{ action: string, target: string, value?: string }}
   */
  detectAction(instruction) {
    if (!instruction) return { action: 'click', target: 'unknown' };

    const cleaned = instruction.trim();

    // Try each detection pattern
    for (const pattern of DETECT_PATTERNS) {
      const match = cleaned.match(pattern.regex);
      if (match) {
        let target = (match[1] || '').trim();
        let value = undefined;

        // For type/select actions, first capture is value, second is target
        if ((pattern.action === 'type' || pattern.action === 'select') && match[2]) {
          value = match[1].trim();
          target = match[2].trim();
        }

        // Clean up quotes from target
        target = target.replace(/^['"]|['"]$/g, '').trim();
        if (value) value = value.replace(/^['"]|['"]$/g, '').trim();

        if (target) {
          return { action: pattern.action, target, value };
        }
      }
    }

    // Fallback: infer action from leading verb
    const verbMatch = cleaned.match(
      /^(click|tap|press|type|enter|fill|select|choose|scroll|navigate|hover|toggle|check|open|close|submit|search|find|drag|upload|download)\b\s*/i
    );
    if (verbMatch) {
      const verb = verbMatch[1].toLowerCase();
      const remainder = cleaned.substring(verbMatch[0].length).trim();
      const action = this._mapVerbToAction(verb);
      return { action, target: remainder || 'unknown' };
    }

    // Last resort: treat entire instruction as a click target
    return { action: 'click', target: cleaned };
  },

  /**
   * Detect and expand multi-field groups (e.g. Date of Birth → Day + Month + Year).
   * Teacher says "Enter date of birth" but DOM has 3 separate selects.
   *
   * @param {StepSequence[]} steps — normalized step array
   * @param {object[]} domElements — flattened DOM element list
   * @returns {StepSequence[]} steps with groups expanded in-place
   */
  detectFieldGroups(steps, domElements) {
    if (!steps || !domElements) return steps || [];

    const groups = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Teacher said "Enter date of birth" but DOM has 3 separate selects
      if (step.action === 'select' && step.target.match(/date|birth|dob/i)) {
        // Find consecutive select/input elements that look like date parts
        const dateSelects = domElements.filter(el =>
          el.type === 'dropdown' &&
          (el.label?.match(/day|month|year|dd|mm|yyyy/i) ||
           el.name?.match(/day|month|year|dd|mm|yyyy/i))
        );

        if (dateSelects.length >= 2) {
          // Expand the single step into a GROUP
          groups.push({
            originalStepIndex: i,
            expandedSteps: dateSelects.map((sel, j) => ({
              ...step,
              target: sel.label || sel.name,
              elementIdx: sel._idx,
              groupId: `dob_${i}`,
              groupPosition: j,
              groupTotal: dateSelects.length,
              action: 'select'
            }))
          });
        }
      }

      // Extend: address groups (street + city + state + zip)
      if (step.target.match(/address/i) && step.action === 'type') {
        const addressInputs = domElements.filter(el =>
          (el.type === 'text' || el.type === 'input') &&
          (el.label?.match(/street|city|state|zip|postal|country|province/i) ||
           el.name?.match(/street|city|state|zip|postal|country|province/i) ||
           el.placeholder?.match(/street|city|state|zip|postal|country|province/i))
        );

        if (addressInputs.length >= 2) {
          groups.push({
            originalStepIndex: i,
            expandedSteps: addressInputs.map((inp, j) => ({
              ...step,
              target: inp.label || inp.name || inp.placeholder,
              elementIdx: inp._idx,
              groupId: `address_${i}`,
              groupPosition: j,
              groupTotal: addressInputs.length,
              action: 'type'
            }))
          });
        }
      }
    }

    // Replace original steps with expanded groups (reverse to maintain indices)
    for (const group of groups.reverse()) {
      steps.splice(group.originalStepIndex, 1, ...group.expandedSteps);
    }

    return steps;
  },

  /**
   * Extract position clues from an instruction string.
   * "Click the Share button in the top-right toolbar"
   * → { region: "top-right toolbar", ordinal: null, rawMatch: "in the top-right toolbar" }
   *
   * @param {string} instruction
   * @returns {{ region: string|null, ordinal: string|null, rawMatch: string }|null}
   */
  extractPositionHint(instruction) {
    return extractPositionHint(instruction);
  },

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Map natural-language verb to canonical action name.
   */
  _mapVerbToAction(verb) {
    const MAP = {
      click: 'click', tap: 'click', press: 'click',
      type: 'type', enter: 'type', fill: 'type',
      select: 'select', choose: 'select',
      scroll: 'scroll',
      navigate: 'navigate', 'go to': 'navigate', open: 'navigate',
      close: 'click',
      hover: 'hover', focus: 'focus',
      toggle: 'toggle', check: 'toggle',
      submit: 'click',
      search: 'type', find: 'type',
      drag: 'drag',
      upload: 'click', download: 'click'
    };
    return MAP[verb] || 'click';
  },

  /**
   * Attempt to extract a structured JSON action array from teacher text.
   * Supports ```actions/json ``` fenced blocks and inline JSON.
   */
  _extractJSON(text) {
    try {
      const actionBlockMatch = text.match(/```(?:actions|json)?\s*(\[\s*\{[\s\S]*?\}\s*\])\s*```/i);
      if (actionBlockMatch && actionBlockMatch[1]) {
        return JSON.parse(actionBlockMatch[1]);
      }
      const fallbackMatch = text.match(/(\[\s*\{[\s\S]*"action"[\s\S]*\}\s*\])/);
      if (fallbackMatch && fallbackMatch[1]) {
        return JSON.parse(fallbackMatch[1]);
      }
    } catch (err) {
      console.warn('[FolloMe:Normalizer] JSON parse failed, using text normalization', err);
    }
    return null;
  },

  /**
   * Normalize a single step parsed from JSON output.
   */
  _normalizeJsonStep(obj) {
    let actionStr = (obj.action || 'click').toLowerCase().trim();
    const VALID_ACTIONS = ['click', 'type', 'select', 'scroll', 'hover', 'focus', 'toggle', 'wait', 'navigate', 'drag'];
    if (!VALID_ACTIONS.includes(actionStr)) actionStr = 'click';

    const target = (obj.target || obj.element || 'unknown').trim();
    const hintData = obj.hint || obj.explanation || obj.description || `${actionStr} on ${target}`;
    const positionHint = extractPositionHint(hintData);

    return {
      index: 0, // re-indexed by caller
      instruction: hintData.trim(),
      action: actionStr,
      target: target,
      value: obj.value !== undefined ? String(obj.value) : undefined,
      positionHint: positionHint,
      hint: hintData.trim(),
      status: 'pending'
    };
  }
};


// ───────────────────────────────────────────────────────────────────────
//  Standalone helper: extractPositionHint  (used by both StepNormalizer
//  and externally by groq-mapper for prompt enrichment)
// ───────────────────────────────────────────────────────────────────────

function extractPositionHint(instruction) {
  if (!instruction) return null;

  for (const pattern of POSITION_PATTERNS) {
    const match = instruction.match(pattern.regex);
    if (match) {
      return {
        region: pattern.region ? match[1].toLowerCase().trim() : null,
        ordinal: pattern.ordinal ? match[1].toLowerCase() : null,
        rawMatch: match[0]
      };
    }
  }
  return null;
}


// ───────────────────────────────────────────────────────────────────────
//  Exports — dual mode: ES module + global fallback
// ───────────────────────────────────────────────────────────────────────

// ES module exports (Service Worker with "type": "module")
export { ContextCompressor, StepNormalizer, extractPositionHint };

// Global fallback for content script injection via chrome.scripting.executeScript
if (typeof self !== 'undefined') {
  self.ContextCompressor = ContextCompressor;
  self.StepNormalizer = StepNormalizer;
  self.extractPositionHint = extractPositionHint;
}
