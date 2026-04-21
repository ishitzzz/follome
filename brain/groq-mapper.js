/**
 * FolloMe — Groq Mapper v3 (Batch Element Resolution)
 *
 * Thin mapper layer that sends normalised instruction steps + DOM element list
 * to the Groq LLM and returns per-step element matches with confidence scores.
 *
 * Key v3 capabilities:
 *   - batchMapInstructions(): single API call resolves ALL steps at once
 *   - mapInstructionToElement(): single-step fallback with alternates[]
 *   - Domain-aware prompt building (via matchingStrategy from IntentProfiler)
 *   - Position-hint enriched prompts (from StepNormaliser's extractPositionHint)
 *   - ResolutionModeSelector: DOM-first, vision only as last-resort escalation
 *   - selectModel(): text model default, vision model only when explicitly escalated
 *   - AbortSignal support on all fetch calls for DOM-version invalidation
 *
 * Consumed by the Service Worker (ES module import).
 */

// ───────────────────────────────────────────────────────────────────────
//  Constants
// ───────────────────────────────────────────────────────────────────────

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// ───────────────────────────────────────────────────────────────────────
//  API key retrieval
// ───────────────────────────────────────────────────────────────────────

async function getApiKey() {
  return new Promise((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['follome_groq_api_key'], (res) => {
        resolve(res.follome_groq_api_key || null);
      });
    } else {
      resolve(null);
    }
  });
}

// ───────────────────────────────────────────────────────────────────────
//  Model Selection  (Gap 4)
// ───────────────────────────────────────────────────────────────────────

/**
 * Returns the Groq model ID based on resolution mode.
 * Default: always use the fast text model.
 * Vision model ONLY when RecoveryEngine explicitly escalates a step.
 *
 * @param {string} mode — 'DOM_ONLY' | 'VISION'
 * @returns {string} model identifier
 */
function selectModel(mode) {
  return mode === 'VISION'
    ? 'llama-3.2-11b-vision-preview'
    : 'llama-3.3-70b-versatile';
}

// ───────────────────────────────────────────────────────────────────────
//  Resolution Mode Selector  (Gap 4)
// ───────────────────────────────────────────────────────────────────────

const ResolutionModeSelector = {

  /**
   * Returns the resolution mode. DOM_ONLY is ALWAYS the starting mode.
   * Vision is only triggered as a recovery fallback per-step, never pre-emptively.
   *
   * @param {object} pageAnalysis — { domain, interactiveCount, canvasCount }
   * @returns {string} 'DOM_ONLY'
   */
  selectMode(pageAnalysis) {
    // ALWAYS start with DOM_ONLY. No exceptions.
    // Vision is triggered per-step by the recovery engine, not pre-selected.
    return 'DOM_ONLY';
  },

  /**
   * Determine if a SPECIFIC failed step should escalate to vision.
   * Called by RecoveryEngine AFTER DOM + local matcher both failed.
   *
   * @param {object} failedStep — { retryCount, confidence, ... }
   * @param {object} pageAnalysis — { domain, interactiveCount, canvasCount }
   * @returns {boolean}
   */
  shouldEscalateToVision(failedStep, pageAnalysis) {
    const { domain, interactiveCount, canvasCount } = pageAnalysis || {};

    // Canvas-heavy pages — DOM genuinely can't resolve canvas-internal tools
    if (canvasCount > 0 && interactiveCount < 5) return true;

    // Step already failed Groq DOM + local matcher — vision is last hope
    if (failedStep.retryCount >= 2) return true;

    // Domain hint: design tools may have icon-only buttons
    if (domain === 'design_tool' && failedStep.confidence < 0.3) return true;

    // Default: don't escalate to vision — try disambiguation instead
    return false;
  }
};

// ───────────────────────────────────────────────────────────────────────
//  Batch Prompt Builder
// ───────────────────────────────────────────────────────────────────────

/**
 * Build the Groq prompt for batch element resolution.
 * Includes all DOM elements and all instruction steps in a single prompt.
 * Attaches domain-specific matching strategy and per-step position hints.
 *
 * @param {Array} steps — [{ instruction, positionHint?, ... }]
 * @param {Array} domElements — [{ idx, type, text, ariaLabel, placeholder, title, region }]
 * @param {object} context — { pageURL, domain, matchingStrategy? }
 * @returns {string}
 */
function buildBatchPrompt(steps, domElements, context) {
  let prompt = `You are an element resolver. Given UI elements and a list of instructions, return the matching element for EACH instruction in one response.

PAGE: ${context.pageURL || 'unknown'}`;

  // Attach domain-specific matching strategy hint if available
  if (context.matchingStrategy && context.matchingStrategy.prompt) {
    prompt += `\nMATCHING STRATEGY: ${context.matchingStrategy.prompt}`;
  } else if (context.domain) {
    // Inline fallback hints per domain
    const domainHints = {
      web_form: 'Match using field labels, placeholders, and input names. Prioritize exact label matches.',
      design_tool: 'Match using toolbar tooltips, icon aria-labels, and panel headers.',
      dashboard: 'Match using section headings, chart titles, and table headers.',
      code_editor: 'Match using tab names, file tree labels, and toolbar text. Check aria-label and title attributes.'
    };
    if (domainHints[context.domain]) {
      prompt += `\nMATCHING STRATEGY: ${domainHints[context.domain]}`;
    }
  }

  prompt += `\nELEMENTS:\n`;

  for (const el of domElements) {
    const region = el.region || 'unknown';
    prompt += `[${el.idx}] ${el.type}, text="${el.text}", region=${region}`;
    if (el.ariaLabel) prompt += `, aria="${el.ariaLabel}"`;
    if (el.placeholder) prompt += `, placeholder="${el.placeholder}"`;
    if (el.title) prompt += `, title="${el.title}"`;
    prompt += '\n';
  }

  prompt += `\nINSTRUCTIONS:\n`;
  for (let i = 0; i < steps.length; i++) {
    prompt += `[${i}] "${steps[i].instruction}"`;
    if (steps[i].positionHint) {
      // positionHint may be an object { region, ordinal, rawMatch } or a string
      const hint = typeof steps[i].positionHint === 'string'
        ? steps[i].positionHint
        : (steps[i].positionHint.region || steps[i].positionHint.ordinal || steps[i].positionHint.rawMatch || '');
      if (hint) prompt += ` (hint: ${hint})`;
    }
    prompt += '\n';
  }

  prompt += `\nReturn a JSON array with one entry per instruction:
[{"step":0,"idx":N,"confidence":0.0-1.0}, {"step":1,"idx":N,"confidence":0.0-1.0}, ...]
If no match for a step: {"step":N,"idx":null,"confidence":0}`;

  return prompt;
}

// ───────────────────────────────────────────────────────────────────────
//  Batch Response Parser
// ───────────────────────────────────────────────────────────────────────

/**
 * Parse the Groq batch response into a per-step result array.
 *
 * @param {object} data — raw Groq API response JSON
 * @param {number} stepCount — expected number of steps
 * @returns {Array<{ idx: number|null, confidence: number }>}
 */
function parseBatchResponse(data, stepCount) {
  try {
    const text = data.choices[0].message.content;
    // Extract JSON array from response (handles markdown fencing)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return Array(stepCount).fill({ idx: null, confidence: 0 });

    const results = JSON.parse(jsonMatch[0]);
    // Ensure we have entries for all steps
    const mapped = Array(stepCount).fill(null);
    for (const r of results) {
      if (r.step >= 0 && r.step < stepCount) {
        mapped[r.step] = { idx: r.idx, confidence: r.confidence || 0 };
      }
    }
    return mapped.map(m => m || { idx: null, confidence: 0 });
  } catch (e) {
    console.error('[GroqMapper] Batch parse failed:', e);
    return Array(stepCount).fill({ idx: null, confidence: 0 });
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Batch Map Instructions  (primary API — single call for ALL steps)
// ───────────────────────────────────────────────────────────────────────

/**
 * Map ALL instruction steps to DOM elements in a single Groq API call.
 * This is the primary resolution path — one call resolves everything.
 *
 * @param {Array} steps — [{ instruction, positionHint?, ... }]
 * @param {Array} domElements — [{ idx, type, text, ariaLabel, ... }]
 * @param {object} context — { mode?, domain?, pageURL, matchingStrategy? }
 * @param {AbortSignal} [signal] — for DOM-version invalidation
 * @returns {Promise<Array<{ idx: number|null, confidence: number }>>}
 */
async function batchMapInstructions(steps, domElements, context, signal) {
  if (!steps || steps.length === 0) return [];
  if (!domElements || domElements.length === 0) {
    return Array(steps.length).fill({ idx: null, confidence: 0 });
  }

  const apiKey = (context && context.apiKey) ? context.apiKey : await getApiKey();
  if (!apiKey) {
    console.error('[GroqMapper] API key missing — cannot batch map. Pass apiKey in context or set follome_groq_api_key in chrome.storage.local.');
    return Array(steps.length).fill({ idx: null, confidence: 0 });
  }

  // Check signal before network call
  if (signal?.aborted) {
    console.warn('[GroqMapper] Aborted before batch API call (DOM stale).');
    return Array(steps.length).fill({ idx: null, confidence: 0 });
  }

  const prompt = buildBatchPrompt(steps, domElements, context || {});

  try {
    console.log(`[GroqMapper] Batch mapping ${steps.length} steps against ${domElements.length} elements...`);
    const elements = domElements;
    console.log('[GroqMapper] Sending DOM elements to Groq:', elements);

    const response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "model": "llama-3.3-70b-versatile",
        messages: [
          { role: 'system', content: `CRITICAL RESTRAINT: You must output a valid JSON object. It MUST contain a single key called 'mappings'. The value of 'mappings' must be an array of exactly ${steps.length} objects. Example: {"mappings": [{"step": 0, "idx": 12, "confidence": 1.0}]}. CRITICAL MATCHING DIRECTIVE: The user's steps are conversational. The UI elements are raw HTML. You MUST use aggressive fuzzy semantic matching. If a step mentions 'email', 'phone', 'username', or 'login details', you MUST map it to an element with type 'input_field'. Do not be overly literal. Find the logical target and assign confidence 1.0. Do NOT return null if a logical input field exists. CRITICAL UI DIRECTIVE: If the step mentions 'Date', 'Day', 'Month', or 'Year', you MUST map it to an element with type 'select' or a 'div' that acts as a dropdown. DO NOT map it to icons, labels, or question marks.` },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 2048
      }),
      signal
    });

    // Check signal after network call returns (DOM may have changed during latency)
    if (signal?.aborted) {
      console.warn('[GroqMapper] Aborted after fetch returned (DOM stale).');
      return Array(steps.length).fill({ idx: null, confidence: 0 });
    }

    if (!response.ok) {
      console.error(`[GroqMapper] Groq HTTP error: ${response.status} ${response.statusText}`);
      return Array(steps.length).fill({ idx: null, confidence: 0 });
    }

    const data = await response.json();

    const rawContent = data.choices[0].message.content;
    console.log('[GroqMapper] RAW LLM OUTPUT:', rawContent);

    let parsedMappings = [];
    try {
      const parsedData = JSON.parse(rawContent);
      parsedMappings = parsedData.mappings || [];
      console.log('[GroqMapper] Successfully parsed mappings:', parsedMappings);
    } catch (e) {
      console.error('[GroqMapper] Failed to parse JSON from Groq:', e, rawContent);
    }

    // Map parsed results into per-step format
    const mapped = Array(steps.length).fill(null);
    for (const r of parsedMappings) {
      if (r.step >= 0 && r.step < steps.length) {
        mapped[r.step] = { idx: r.idx, confidence: r.confidence || 0 };
      }
    }
    return mapped.map(m => m || { idx: null, confidence: 0 });

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[GroqMapper] Batch fetch aborted (DOM version changed).');
    } else {
      console.error('[GroqMapper] Batch mapping failed:', err);
    }
    return Array(steps.length).fill({ idx: null, confidence: 0 });
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Single-step mapper prompt builder  (for recovery retries)
// ───────────────────────────────────────────────────────────────────────

/**
 * Build a single-instruction Groq prompt with position hints.
 * Used by mapInstructionToElement and Recovery Engine retries.
 *
 * @param {string} instruction
 * @param {Array} domElements
 * @param {object} context — { pageURL, domain, positionHint?, matchingStrategy?, screenshot? }
 * @returns {string}
 */
function buildMapperPrompt(instruction, domElements, context) {
  let prompt = `You are an element resolver. Given UI elements and an instruction, return the matching element.

PAGE: ${context.pageURL || 'unknown'}`;

  // Domain-specific matching strategy
  if (context.matchingStrategy && context.matchingStrategy.prompt) {
    prompt += `\nMATCHING STRATEGY: ${context.matchingStrategy.prompt}`;
  }

  prompt += `\nELEMENTS:\n`;

  for (const el of domElements) {
    const region = el.region || 'unknown';
    prompt += `[${el.idx}] ${el.type}, text="${el.text}", region=${region}`;
    if (el.ariaLabel) prompt += `, aria="${el.ariaLabel}"`;
    if (el.placeholder) prompt += `, placeholder="${el.placeholder}"`;
    if (el.title) prompt += `, title="${el.title}"`;
    prompt += '\n';
  }

  prompt += `\nINSTRUCTION: "${instruction}"`;

  // Attach position hint if available — helps Groq filter by region
  if (context.positionHint) {
    const hint = typeof context.positionHint === 'string'
      ? context.positionHint
      : (context.positionHint.region || context.positionHint.rawMatch || '');
    if (hint) {
      prompt += `\nPOSITION HINT: The element is in the "${hint}" area of the page.`;
    }
  }

  prompt += `\n\nReturn JSON: {"idx": N, "confidence": 0.0-1.0, "alternates": [{"idx": N, "confidence": 0.0-1.0}]}`;
  prompt += `\nIf no match: {"idx": null, "confidence": 0, "alternates": []}`;

  return prompt;
}

// ───────────────────────────────────────────────────────────────────────
//  Single-step Element Mapping  (fallback / recovery path)
// ───────────────────────────────────────────────────────────────────────

/**
 * Map a single instruction to a DOM element via Groq.
 * Returns the primary match plus up to 3 alternates.
 * Used by Recovery Engine for per-step retries with expanded context.
 *
 * @param {string} instruction — natural-language instruction
 * @param {Array} domElements — [{ idx, type, text, ariaLabel, ... }]
 * @param {object} context — { mode?, domain?, pageURL, positionHint?, matchingStrategy?, screenshot? }
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ idx: number|null, selector: string|null, confidence: number, alternates: Array }>}
 */
async function mapInstructionToElement(instruction, domElements, context, signal) {
  const emptyResult = { idx: null, selector: null, confidence: 0, alternates: [] };

  if (!instruction || !domElements || domElements.length === 0) return emptyResult;

  const apiKey = (context && context.apiKey) ? context.apiKey : await getApiKey();
  if (!apiKey) {
    console.error('[GroqMapper] API key missing — cannot map single instruction. Pass apiKey in context or set follome_groq_api_key in chrome.storage.local.');
    return emptyResult;
  }

  // Check signal before network call
  if (signal?.aborted) return emptyResult;

  const prompt = buildMapperPrompt(instruction, domElements, context || {});
  const messages = [{ role: 'user', content: prompt }];

  // If vision mode and screenshot attached, build multimodal message
  if ((context || {}).mode === 'VISION' && context.screenshot) {
    messages[0] = {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${context.screenshot}` } }
      ]
    };
  }

  try {
    console.log(`[GroqMapper] Single-step mapping: "${instruction.substring(0, 50)}..."`);

    const response = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "model": "llama-3.3-70b-versatile",
        messages: [
          { role: 'system', content: 'CRITICAL INSTRUCTION: You are a strict JSON data API. You MUST output ONLY a valid, raw JSON object. DO NOT output markdown formatting, DO NOT output conversational text, and DO NOT output Python code or scripts. Just the raw JSON object. CRITICAL MATCHING DIRECTIVE: The user\'s steps are conversational. The UI elements are raw HTML. You MUST use aggressive fuzzy semantic matching. If a step mentions \'email\', \'phone\', \'username\', or \'login details\', you MUST map it to an element with type \'input_field\'. Do not be overly literal. Find the logical target and assign confidence 1.0. Do NOT return null if a logical input field exists. CRITICAL UI DIRECTIVE: If the step mentions \'Date\', \'Day\', \'Month\', or \'Year\', you MUST map it to an element with type \'select\' or a \'div\' that acts as a dropdown. DO NOT map it to icons, labels, or question marks.' },
          ...messages
        ],
        temperature: 0,
        max_tokens: 1024
      }),
      signal
    });

    // Validate signal again after response
    if (signal?.aborted) return emptyResult;

    if (!response.ok) {
      console.error(`[GroqMapper] Groq HTTP error: ${response.status}`);
      return emptyResult;
    }

    const data = await response.json();
    const text = data.choices[0].message.content;

    // Parse JSON response — expect { idx, confidence, alternates }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return emptyResult;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      idx: parsed.idx !== undefined ? parsed.idx : null,
      selector: parsed.selector || null,
      confidence: parsed.confidence || 0,
      alternates: Array.isArray(parsed.alternates)
        ? parsed.alternates.slice(0, 3).map(a => ({
            idx: a.idx,
            confidence: a.confidence || 0
          }))
        : []
    };

  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[GroqMapper] Single-step fetch aborted.');
    } else {
      console.error('[GroqMapper] Single-step mapping failed:', err);
    }
    return emptyResult;
  }
}

// ───────────────────────────────────────────────────────────────────────
//  Exports — ES module + global fallback
// ───────────────────────────────────────────────────────────────────────

const GroqMapper = {
  batchMapInstructions,
  mapInstructionToElement,
  buildBatchPrompt,
  buildMapperPrompt,
  parseBatchResponse,
  selectModel,
  ResolutionModeSelector
};

// ES module exports (Service Worker with "type": "module")
export {
  batchMapInstructions,
  mapInstructionToElement,
  buildBatchPrompt,
  buildMapperPrompt,
  parseBatchResponse,
  selectModel,
  ResolutionModeSelector,
  GroqMapper
};

// Global fallback for content script injection
if (typeof self !== 'undefined') {
  self.GroqMapper = GroqMapper;
  self.ResolutionModeSelector = ResolutionModeSelector;
}
