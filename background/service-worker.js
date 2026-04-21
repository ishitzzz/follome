/**
 * FolloMe — Background Service Worker
 * Handles tab management, message routing, and the v3 guidance pipeline.
 */

// ─────────────────────────────────────────────────────────────────────
// v3 ES Module Imports (manifest: "type": "module")
// ─────────────────────────────────────────────────────────────────────
import { ContextCompressor, StepNormalizer } from '../brain/step-normalizer.js';
import { batchMapInstructions, mapInstructionToElement, ResolutionModeSelector, selectModel, GroqMapper } from '../brain/groq-mapper.js';
const AI_URLS = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  claude: 'https://claude.ai/new'
};

const AI_PATTERNS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'claude.ai'
];

/**
 * Restricted URL patterns where content scripts cannot run.
 * Messaging to these pages must be blocked before any sendMessage call.
 */
const RESTRICTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'devtools://',
  'view-source:',
  'chrome-search://',
  'chrome-untrusted://',
];

const RESTRICTED_DOMAINS = [
  'chromewebstore.google.com',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com/addons',
];

let sourceTabId = null;
let aiTabId = null;

// ─────────────────────────────────────────────────────────────────────
// v3 Guidance Pipeline State
// ─────────────────────────────────────────────────────────────────────

// GuidanceSession + SyncController are loaded inline (cannot use ES import
// for files that also load as content scripts via manifest content_scripts).
// They attach to `self` when loaded. We lazy-init them here.
let activeSession = null;

/**
 * Get or create the SyncController.
 * It's defined in brain/guidance-state.js which is loaded as a content script.
 * In the service worker context, we define a minimal inline version.
 */
const SyncController = {
  _domVersion: 0,
  _opLock: null,
  _opAbort: null,
  _pendingResolve: null,

  get domVersion() { return this._domVersion; },
  get signal() { return this._opAbort ? this._opAbort.signal : null; },

  onDOMChanged() {
    this._domVersion++;
    if (this._opAbort) {
      this._opAbort.abort();
      this._opAbort = null;
    }
  },

  async runPipeline(domSnapshot, pipelineFn) {
    if (this._opLock) {
      this._opAbort?.abort();
      await this._opLock;
    }

    const startVersion = this._domVersion;
    this._opAbort = new AbortController();
    const signal = this._opAbort.signal;

    this._opLock = new Promise(resolve => {
      this._pendingResolve = resolve;
    });

    try {
      const result = await pipelineFn(domSnapshot, signal);
      if (this._domVersion !== startVersion) {
        console.warn(`[Sync] DOM changed during pipeline (v${startVersion}→v${this._domVersion}). Discarding.`);
        return null;
      }
      return result;
    } finally {
      this._pendingResolve?.();
      this._opLock = null;
      this._opAbort = null;
    }
  }
};

/**
 * Minimal GuidanceSession for service worker context.
 * Full class is in brain/guidance-state.js; this is a lightweight inline version
 * since the SW can't import content-script-only files as ES modules.
 */
class GuidanceSession {
  constructor(sourceTabId) {
    this._version = 0;
    this._sourceTabId = sourceTabId || null;
    this._data = {
      sessionId: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'idle',
      domVersion: 0,
      teacherData: null,
      steps: [],
      currentStepIndex: -1,
      pipelineStage: null,
      errors: [],
      timeline: []
    };
  }

  mutate(mutator, reason) {
    const prevStatus = this._data.status;
    mutator(this._data);
    this._version++;
    this._data.timeline.push({
      version: this._version,
      timestamp: Date.now(),
      reason,
      fromStatus: prevStatus,
      toStatus: this._data.status,
      pipelineStage: this._data.pipelineStage
    });
    if (this._data.timeline.length > 200) {
      this._data.timeline = this._data.timeline.slice(-100);
    }
    this._persist();
    this._notifyContentScript();
  }

  getProjection() {
    return {
      version: this._version,
      sessionId: this._data.sessionId,
      status: this._data.status,
      currentStepIndex: this._data.currentStepIndex,
      steps: this._data.steps.map(s => ({
        instruction: s.instruction,
        action: s.action,
        status: s.status,
        confidence: s.confidence,
        resolvedVia: s.resolvedVia,
        elementSelector: s.elementSelector,
        elementIdx: s.elementIdx,
        hint: s.hint,
        groupId: s.groupId
      })),
      pipelineStage: this._data.pipelineStage,
      errorCount: this._data.errors.length,
      lastError: this._data.errors[this._data.errors.length - 1] || null
    };
  }

  async _persist() {
    try {
      await chrome.storage.session.set({
        'follome_session': {
          version: this._version,
          data: { ...this._data, steps: this._data.steps.map(s => ({ ...s, _element: undefined })) }
        }
      });
    } catch (e) {
      console.warn('[GuidanceSession] Persist failed:', e);
    }
  }

  async _notifyContentScript() {
    if (this._sourceTabId) {
      try {
        await chrome.tabs.sendMessage(this._sourceTabId, {
          type: 'SESSION_STATE_UPDATE',
          projection: this.getProjection()
        });
      } catch { /* tab may be closed */ }
    }
  }

  setSourceTab(tabId) { this._sourceTabId = tabId; }
  getData() { return this._data; }
  getVersion() { return this._version; }
}


// ─────────────────────────────────────────────────────────────────────
// v3 Master Orchestrator: executeGuidancePipeline
// ─────────────────────────────────────────────────────────────────────

/**
 * Master orchestrator for the v3 guidance pipeline.
 * Runs the full Teacher → Normalize → Validate → Map → Execute flow.
 *
 * @param {string} teacherText — raw Teacher AI response text
 * @param {number} tabId — source tab to send guidance to
 * @param {object} [domSnapshot] — { elements: [...], url, title } (if pre-fetched)
 */
async function executeGuidancePipeline(teacherText, tabId, domSnapshot) {
  const domElements = Array.isArray(domSnapshot) ? domSnapshot : (domSnapshot?.elements || []);
  const pageUrl = domSnapshot?.url || 'unknown';
  const logPrefix = '[FolloMe:Pipeline]';
  console.log(`${logPrefix} Starting guidance pipeline for tab ${tabId}`);

  // ── Step 1: Initialize session ──
  activeSession = new GuidanceSession(tabId);
  activeSession.mutate(data => {
    data.status = 'normalizing';
    data.pipelineStage = 'step_normalizer';
    data.teacherData = teacherText;
  }, 'pipeline_start');

  // ── Step 2: Normalize teacher text into steps ──
  let normalizedSteps;
  try {
    const { steps, explanation } = StepNormalizer.splitExplanationAndSteps(teacherText);
    normalizedSteps = steps;
    console.log(`${logPrefix} Normalized ${normalizedSteps.length} steps from teacher response`);

    if (normalizedSteps.length === 0) {
      console.warn(`${logPrefix} No actionable steps found in teacher response`);
      activeSession.mutate(data => {
        data.status = 'completed';
        data.pipelineStage = null;
      }, 'no_actionable_steps');

      // Still send the response text for overlay display
      await safeSendMessage(tabId, {
        type: 'SHOW_RESPONSE',
        response: teacherText,
        explanation: explanation || teacherText
      });
      return;
    }

    activeSession.mutate(data => {
      data.steps = normalizedSteps.map((s, i) => ({
        ...s,
        index: i,
        status: 'pending'
      }));
      data.status = 'mapping';
      data.pipelineStage = 'groq_mapper';
    }, 'normalization_complete');
  } catch (err) {
    console.error(`${logPrefix} Normalization failed:`, err);
    activeSession.mutate(data => {
      data.status = 'failed';
      data.errors.push({ stage: 'normalizer', error: err.message, timestamp: Date.now() });
    }, 'normalization_error');
    return;
  }

  // ── Step 3: Get DOM snapshot from content script (if not pre-fetched) ──
  if (!domSnapshot) {
    try {
      const domResponse = await safeSendMessage(tabId, { type: 'GET_DOM_SNAPSHOT' });
      if (domResponse && domResponse.elements) {
        domSnapshot = domResponse;
      } else {
        console.warn(`${logPrefix} Could not get DOM snapshot from tab ${tabId}`);
        // Proceed without DOM — we'll send steps without element mapping
        domSnapshot = { elements: [], url: '', title: '' };
      }
    } catch {
      domSnapshot = { elements: [], url: '', title: '' };
    }
  }

  // ── Step 4: Batch map via Groq (wrapped in SyncController) ──
  let resolvedSteps = normalizedSteps;

  if (domElements.length > 0) {
    const pipelineResult = await SyncController.runPipeline(domSnapshot, async (snapshot, signal) => {
      console.log(`${logPrefix} Batch mapping ${normalizedSteps.length} steps against ${domElements.length} DOM elements`);

      const syncStorage = await chrome.storage.sync.get('groqApiKey');
      const apiKey = syncStorage.groqApiKey;
      if (!apiKey) {
        safeSendMessage(tabId, { type: 'SHOW_ERROR', error: 'Groq API Key is missing. Please set it in the extension popup.' });
        throw new Error('Groq API Key missing');
      }

      const batchResults = await GroqMapper.batchMapInstructions(
        normalizedSteps,
        domElements,
        { mode: 'DOM_ONLY', domain: pageUrl, pageURL: pageUrl, apiKey: apiKey },
        signal
      );

      if (!batchResults || !batchResults.length) {
         throw new Error('Groq mapping returned undefined or empty');
      }

      // Merge batch results into step objects
      const merged = normalizedSteps.map((step, i) => {
        const result = batchResults[i] || { idx: null, confidence: 0 };
        return {
          ...step,
          elementIdx: result.idx,
          confidence: result.confidence,
          status: result.confidence >= 0.4 ? 'resolved' : 'pending',
          resolvedVia: result.confidence >= 0.4 ? 'groq_batch' : 'unresolved'
        };
      });

      return merged;
    });

    if (pipelineResult) {
      resolvedSteps = pipelineResult;
      const resolvedCount = resolvedSteps.filter(s => s.status === 'resolved').length;
      console.log(`${logPrefix} Batch mapping complete. Resolved: ${resolvedCount}/${resolvedSteps.length}`);

      const chatGptTabs = await chrome.tabs.query({url: "*://chatgpt.com/*"});
      if (resolvedCount < (normalizedSteps.length * 0.6) && chatGptTabs.length > 0) {
          console.log('[FolloMe:Pipeline] Threshold failed. Triggering Autonomous Fallback...');
          const teacherTabId = chatGptTabs[0].id;
          safeSendMessage(tabId, { type: 'SHOW_LOADING', message: 'Asking AI for updated steps...' });
          
          // Summarize the DOM so ChatGPT knows what page we are actually on
          const domSummary = domElements.slice(0, 15).map(e => e.text).filter(Boolean).join(', ');
          const fallbackPrompt = `The user is trying to follow your instructions, but they are on a page with these elements: [${domSummary}]. The previous steps don't match. Give me the EXACT next 3 steps for this specific page layout.`;
          
          try {
              // Secretly ask ChatGPT via our Relay
              const newTeacherResponse = await new Promise((resolve, reject) => {
                  chrome.tabs.sendMessage(teacherTabId, { type: 'ASK_TEACHER', prompt: fallbackPrompt }, (res) => {
                      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                      else resolve(res);
                  });
              });
              
              if (newTeacherResponse && newTeacherResponse.text) {
                  console.log('[FolloMe:Pipeline] Received dynamic correction from Teacher!');
                  // Re-normalize and re-map with the new instructions
                  const { steps: newNormalizedSteps } = StepNormalizer.splitExplanationAndSteps(newTeacherResponse.text);
                  const syncStorage = await chrome.storage.sync.get('groqApiKey');
                  const retryBatch = await GroqMapper.batchMapInstructions(
                      newNormalizedSteps,
                      domElements,
                      { mode: 'DOM_ONLY', domain: pageUrl, pageURL: pageUrl, apiKey: syncStorage.groqApiKey },
                      null
                  );
                  
                  // Re-apply resolved targets
                  resolvedSteps = newNormalizedSteps.map((step, i) => {
                      const result = retryBatch[i] || { idx: null, confidence: 0 };
                      return {
                          ...step,
                          elementIdx: result.idx,
                          confidence: result.confidence,
                          status: result.confidence >= 0.4 ? 'resolved' : 'pending',
                          resolvedVia: result.confidence >= 0.4 ? 'groq_batch_fallback' : 'unresolved'
                      };
                  });
              }
          } catch (error) {
              console.error('[FolloMe:Pipeline] Fallback failed:', error);
          }
          return; // Abort the broken pipeline so it doesn't execute the bad steps!
      }
    } else {
      console.warn(`${logPrefix} Pipeline invalidated (DOM changed). Using unresolved steps.`);
    }
  } else {
    console.warn(`${logPrefix} No DOM elements available — sending steps without element mapping`);
  }

  // ── Step 5: Update session with resolved steps ──
  activeSession.mutate(data => {
    data.steps = resolvedSteps.map((s, i) => ({
      ...s,
      index: i
    }));
    data.currentStepIndex = 0;
    data.status = 'executing';
    data.pipelineStage = 'cursor_engine';
  }, 'mapping_complete');

  // ── Deduplicate Consecutive Steps ──
  const cleanedSteps = [];
  let lastIdx = null;
  resolvedSteps.forEach(step => {
      if (step.status === 'resolved' && step.elementIdx !== null && step.elementIdx !== undefined) {
          if (step.elementIdx !== lastIdx) {
              cleanedSteps.push(step);
              lastIdx = step.elementIdx;
          }
      }
  });

  // ── Step 6: Send to content script for execution ──
  const sendResult = await safeSendMessage(tabId, {
    type: 'EXECUTE_GUIDANCE',
    steps: cleanedSteps,
    explanation: teacherText,
    sessionId: activeSession.getData().sessionId
  });

  if (sendResult) {
    console.log(`${logPrefix} ✓ Guidance pipeline complete. ${cleanedSteps.length} steps sent to tab ${tabId}`);
  } else {
    console.error(`${logPrefix} Failed to deliver guidance to tab ${tabId}`);
    activeSession.mutate(data => {
      data.status = 'failed';
      data.errors.push({ stage: 'delivery', error: 'Message delivery failed', timestamp: Date.now() });
    }, 'delivery_failed');
  }
}

function isAIUrl(url) {
  return AI_PATTERNS.some(p => url?.includes(p));
}

/**
 * Check if a URL is restricted (cannot host content scripts).
 * @param {string|undefined} url
 * @returns {{ restricted: boolean, reason: string }}
 */
function checkRestricted(url) {
  if (!url) {
    return { restricted: true, reason: 'no URL available' };
  }

  for (const prefix of RESTRICTED_PREFIXES) {
    if (url.startsWith(prefix)) {
      return { restricted: true, reason: `restricted prefix: ${prefix}` };
    }
  }

  for (const domain of RESTRICTED_DOMAINS) {
    if (url.includes(domain)) {
      return { restricted: true, reason: `restricted domain: ${domain}` };
    }
  }

  // data: and blob: URLs also can't host content scripts
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return { restricted: true, reason: `unsupported scheme: ${url.split(':')[0]}` };
  }

  return { restricted: false, reason: '' };
}

async function findAITab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find(tab => tab.url && isAIUrl(tab.url)) || null;
}

/**
 * Inject content scripts into a tab.
 * Returns true if injection succeeded, false otherwise.
 */
async function injectContentScripts(tabId, tab) {
  try {
    if (isAIUrl(tab.url)) {
      let adapterJs = 'adapters/chatgpt-adapter.js';
      if (tab.url.includes('gemini')) adapterJs = 'adapters/gemini-adapter.js';
      if (tab.url.includes('claude')) adapterJs = 'adapters/claude-adapter.js';

      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'utils/storage.js', 'utils/analytics.js',
          'adapters/base-adapter.js', adapterJs,
          'adapters/router.js', 'content/ai-content.js'
        ]
      });
      console.log(`[FolloMe] Injected AI content scripts into tab ${tabId}`);
    } else {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'utils/context-extractor.js',
          'brain/guidance-state.js',
          'content/passive-tracker.js',
          'content/overlay.js',
          'content/cursor-guide.js',
          'content/content.js'
        ]
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/overlay.css', 'content/cursor-guide.css']
      });
      console.log(`[FolloMe] Injected main content scripts + CSS into tab ${tabId}`);
    }
    return true;
  } catch (err) {
    console.error(`[FolloMe] Script injection failed for tab ${tabId}: ${err.message}`);
    return false;
  }
}

/**
 * Verify a content script listener is alive on a tab.
 * @param {number} tabId
 * @param {'PING'|'PING_AI'} pingType
 * @returns {Promise<boolean>}
 */
async function pingTab(tabId, pingType = 'PING') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: pingType });
    const alive = pingType === 'PING_AI'
      ? response?.status === 'alive_ai'
      : response?.status === 'alive';
    return alive;
  } catch {
    return false;
  }
}

/**
 * Safely send a message to a tab.
 * - Blocks restricted pages before any sendMessage call.
 * - If receiver is missing, injects content scripts and retries once.
 * - Logs full diagnostics on every outcome.
 */
async function safeSendMessage(tabId, message) {
  const logPrefix = `[FolloMe] safeSendMessage(tab=${tabId}, type=${message.type})`;

  // ── Step 1: Get tab info ──
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (err) {
    console.error(`${logPrefix} — tab does not exist or was closed: ${err.message}`);
    return null;
  }

  // ── Step 2: Block restricted pages ──
  const { restricted, reason } = checkRestricted(tab.url);
  if (restricted) {
    console.warn(`${logPrefix} — BLOCKED: ${reason} (url: ${tab.url})`);
    return null;
  }

  console.log(`${logPrefix} — target URL: ${tab.url}`);

  // ── Step 3: Attempt to send message ──
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    console.log(`${logPrefix} — SUCCESS, response:`, response);
    return response;
  } catch (err) {
    // ── Step 4: Handle "Receiving end does not exist" ──
    if (err.message.includes('Receiving end does not exist')) {
      console.warn(`${logPrefix} — no listener found. Attempting script injection...`);

      const injected = await injectContentScripts(tabId, tab);
      if (!injected) {
        console.error(`${logPrefix} — injection FAILED. Cannot deliver message.`);
        return null;
      }

      // Wait for script initialization (300ms gives time for IIFE + listener registration)
      await new Promise(r => setTimeout(r, 300));

      // Verify listener is now present before retrying
      const pingType = isAIUrl(tab.url) ? 'PING_AI' : 'PING';
      const alive = await pingTab(tabId, pingType);
      if (!alive) {
        console.error(`${logPrefix} — injection succeeded but listener is STILL NOT responding. Aborting.`);
        return null;
      }

      // ── Step 5: Retry once ──
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        console.log(`${logPrefix} — SUCCESS after injection, response:`, response);
        return response;
      } catch (retryErr) {
        console.error(`${logPrefix} — FAILED after injection retry: ${retryErr.message}`);
        return null;
      }
    }

    // Some other error
    console.error(`${logPrefix} — unexpected error: ${err.message}`);
    return null;
  }
}

/**
 * Ensure an AI content script is alive
 */
async function ensureAIContentScript(tabId) {
  const response = await safeSendMessage(tabId, { type: 'PING_AI' });
  return response?.status === 'alive_ai';
}

/**
 * Wait for an AI tab to load and the content script to be ready
 */
async function waitForAITab(tabId, timeout = 15000) {
  const start = Date.now();
  console.log(`[FolloMe] Waiting for AI tab ${tabId} to be ready...`);

  while (Date.now() - start < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        const alive = await ensureAIContentScript(tabId);
        if (alive) {
          console.log(`[FolloMe] AI tab ${tabId} is ready and listening.`);
          return true;
        }
      }
    } catch (e) {
      // Tab might have been closed
      console.warn(`[FolloMe] AI tab ${tabId} check failed: ${e.message}`);
      return false;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.error(`[FolloMe] Timeout waiting for AI tab ${tabId}`);
  return false;
}

// ── Message Router ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender.tab?.id ?? 'popup/extension';
  const senderUrl = sender.tab?.url ?? sender.url ?? 'unknown';
  console.log(`[FolloMe] onMessage: type=${message.type}, sender tab=${senderTabId}, url=${senderUrl}`);

  handleMessage(message, sender)
    .then(result => {
      sendResponse(result || { status: 'ok' });
    })
    .catch(err => {
      console.error(`[FolloMe] handleMessage error for ${message.type}:`, err);
      sendResponse({ status: 'error', error: err.message });
    });

  return true; // Keep channel open for async sendResponse
});

async function handleMessage(message, sender) {
  if (message.type === 'START_ANALYSIS') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return { error: 'No active tab' };
    const tab = tabs[0];
    
    // 1. Fetch the stored AI context
    const storage = await chrome.storage.session.get('teacherContext');
    if (!storage || !storage.teacherContext) {
      safeSendMessage(tab.id, { type: 'SHOW_ERROR', error: 'No AI instructions found. Ask ChatGPT first!' });
      return { status: 'no_context' };
    }

    safeSendMessage(tab.id, { type: 'SHOW_LOADING', message: 'Mapping AI steps to page...' });
    
    // 2. Get the DOM snapshot from the target page
    try {
      const res = await safeSendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });
      if (res && res.domSnapshot) {
        const tabUrl = message.url || (sender.tab && sender.tab.url) || (tab && tab.url) || '';
        if (tabUrl.includes('chatgpt.com') || tabUrl.includes('gemini.google.com') || tabUrl.includes('claude.ai')) {
            console.warn('[FolloMe] SECURITY GUARDRAIL: Cannot run guidance on an AI tab. Aborting to prevent infinite loop.');
            return; 
        }
        // 3. Fire the V3 Pipeline
        executeGuidancePipeline(storage.teacherContext, tab.id, res.domSnapshot);
      } else {
        safeSendMessage(tab.id, { type: 'SHOW_ERROR', error: 'Failed to read page. Please refresh.' });
      }
    } catch (e) {
      safeSendMessage(tab.id, { type: 'SHOW_ERROR', error: 'Failed to read page. Please refresh.' });
    }
    return { status: 'started' };
  }

  else if (message.type === 'SEND_TO_AI') {
    console.log('[FolloMe] Context extracted, routing to AI...');
    sourceTabId = sender.tab?.id || sourceTabId;
    const { prompt } = message;

    // STEP 1: Ensure AI tab exists
    let aiTab = await findAITab();
    if (!aiTab) {
      console.log('[FolloMe] Opening new ChatGPT tab...');
      aiTab = await chrome.tabs.create({ url: AI_URLS.chatgpt, active: true });
      console.log('[FolloMe] AI tab opened');
    } else {
      console.log('[FolloMe] Focusing existing AI tab...');
      await chrome.tabs.update(aiTab.id, { active: true });
      await chrome.windows.update(aiTab.windowId, { focused: true });
    }
    aiTabId = aiTab.id;

    // STEP 2: Wait until DOM is ready
    const isReady = await waitForAITab(aiTabId);
    if (!isReady) {
      console.error(`[FolloMe] AI tab ${aiTabId} never became ready`);
      await safeSendMessage(sourceTabId, {
        type: 'SHOW_ERROR',
        error: 'Could not connect to AI page. Please make sure the AI chat is open and try again.'
      });
      return { status: 'error', error: 'AI tab not ready' };
    }

    // STEP 3: Inject prompt
    const injectResult = await safeSendMessage(aiTabId, { type: 'INJECT_PROMPT', prompt, sourceTabId });
    if (!injectResult) {
      console.error('[FolloMe] Failed to deliver INJECT_PROMPT to AI tab');
      await safeSendMessage(sourceTabId, {
        type: 'SHOW_ERROR',
        error: 'Failed to inject prompt into AI page.'
      });
      return { status: 'error', error: 'Prompt injection failed' };
    }

    return { status: 'ok' };
  }

  else if (message.type === 'CONTEXT_UPDATED' || message.type === 'TEACHER_RESPONSE') {
    console.log(`[FolloMe] Context/Teacher Response received from ${message.platform || 'ChatGPT'}`);
    const teacherText = message.response || message.payload;

    if (!teacherText) {
      console.warn('[FolloMe] CONTEXT_UPDATED — empty response, ignoring');
      return { status: 'empty' };
    }

    // a) Cache the raw context in session storage
    try {
      await chrome.storage.session.set({
        teacherContext: teacherText,
        teacherContextTimestamp: message.timestamp || Date.now()
      });
      console.log('[FolloMe] Context cached in session storage');
    } catch (err) {
      console.error('[FolloMe] Failed to cache context:', err);
    }

    // b) Query all active tabs to find the target (non-AI) tab
    const senderTabId = sender?.tab?.id || null;
    try {
      const activeTabs = await chrome.tabs.query({ active: true });
      console.log(`[FolloMe] Found ${activeTabs.length} active tab(s), sender tab: ${senderTabId}`);

      // c) Loop through tabs — find the one that isn't the AI sender tab
      for (const tab of activeTabs) {
        if (tab.id === senderTabId) continue; // skip the AI tab that sent us the context

        const { restricted } = checkRestricted(tab.url);
        if (restricted) continue; // skip restricted pages

        // d) Request DOM snapshot from this candidate tab
        console.log(`[FolloMe] Requesting snapshot from tab ${tab.id}: ${tab.url}`);
        const res = await safeSendMessage(tab.id, { type: 'GET_DOM_SNAPSHOT' });

        if (res && res.domSnapshot) {
          console.log('[FolloMe] Snapshot received, starting guidance pipeline');
          sourceTabId = tab.id; // update sourceTabId for future messages
          executeGuidancePipeline(teacherText, tab.id, res.domSnapshot)
            .catch(err => console.error('[FolloMe] Pipeline execution error:', err));
          return { status: 'pipeline_started' };
        } else {
          console.warn(`[FolloMe] Tab ${tab.id} returned no snapshot, trying next...`);
        }
      }

      // If we also have a sourceTabId from a previous START_ANALYSIS, try that
      if (sourceTabId && sourceTabId !== senderTabId) {
        console.log(`[FolloMe] Falling back to stored sourceTabId ${sourceTabId}`);
        const res = await safeSendMessage(sourceTabId, { type: 'GET_DOM_SNAPSHOT' });
        if (res && res.domSnapshot) {
          executeGuidancePipeline(teacherText, sourceTabId, res.domSnapshot)
            .catch(err => console.error('[FolloMe] Pipeline execution error:', err));
          return { status: 'pipeline_started' };
        }
      }

      console.warn('[FolloMe] CONTEXT_UPDATED — no valid target tab found for guidance');
      return { status: 'cached_no_target' };
    } catch (err) {
      console.error('[FolloMe] Failed during tab discovery:', err);
      return { status: 'error', error: err.message };
    }
  }

  else if (message.type === 'RELAY_TO_TAB') {
    if (!message.targetTabId) {
      console.warn('[FolloMe] RELAY_TO_TAB — no targetTabId specified');
      return { status: 'error', error: 'No target tab' };
    }

    const result = await safeSendMessage(message.targetTabId, message.message);
    if (!result) {
      console.warn(`[FolloMe] RELAY_TO_TAB — failed to deliver to tab ${message.targetTabId}`);
      return { status: 'error', error: 'Relay delivery failed' };
    }

    // Focus source tab back if we got a response
    if (message.message.type === 'SHOW_RESPONSE') {
      try {
        const tab = await chrome.tabs.get(message.targetTabId);
        await chrome.tabs.update(message.targetTabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (e) {
        console.warn('[FolloMe] Failed to focus source tab.', e);
      }
    }

    return { status: 'relayed' };
  }

  else if (message.type === 'FOLLOWUP_QUESTION') {
    if (aiTabId) {
      await chrome.tabs.update(aiTabId, { active: true });
      const tab = await chrome.tabs.get(aiTabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await safeSendMessage(aiTabId, {
        type: 'INJECT_PROMPT',
        prompt: `Follow-up question: ${message.question}`,
        sourceTabId
      });
    } else {
      await handleMessage({ type: 'START_ANALYSIS', question: message.question }, sender);
    }
    return { status: 'ok' };
  }

  else if (message.type === 'STEP_OUTCOME') {
    // Content script reports a step completion or failure
    const { stepIndex, outcome } = message;
    console.log(`[FolloMe] Step ${stepIndex + 1} outcome: ${outcome}`);

    if (activeSession) {
      activeSession.mutate(data => {
        if (data.steps[stepIndex]) {
          data.steps[stepIndex].status = outcome === 'completed' ? 'completed' : 'failed';
          data.steps[stepIndex].completedAt = Date.now();
        }
        // Advance current step index
        if (outcome === 'completed') {
          data.currentStepIndex = Math.min(stepIndex + 1, data.steps.length - 1);
          // Check if all steps are completed
          const allDone = data.steps.every(s => s.status === 'completed' || s.status === 'skipped_by_user');
          if (allDone) {
            data.status = 'completed';
            data.pipelineStage = null;
          }
        }
      }, `step_${stepIndex}_${outcome}`);
    }
    return { status: 'ok' };
  }

  else if (message.type === 'DOM_VERSION_CHANGED') {
    // Content script detected significant DOM change
    console.log(`[FolloMe] DOM version changed: v${message.oldVersion} → v${message.newVersion}`);
    SyncController.onDOMChanged(message);
    return { status: 'ok' };
  }

  else if (message.type === 'PAGE_READY') {
    const tabId = sender?.tab?.id;
    console.log(`[FolloMe] PAGE_READY from tab ${tabId}`);
    return { status: 'ok' };
  }

  else if (message.type === 'DOM_SIGNIFICANT_CHANGE') {
    // Content script detected significant DOM mutation via DOMStabilityMonitor
    console.log(`[FolloMe] DOM significant change detected (score: ${message.score}, affectsTracked: ${message.affectsTrackedElements})`);
    return { status: 'acknowledged' };
  }

  console.warn(`[FolloMe] Unknown message type: ${message.type}`);
  return { status: 'unknown_type' };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === aiTabId) {
    console.log(`[FolloMe] AI tab ${tabId} closed`);
    aiTabId = null;
  }
  if (tabId === sourceTabId) {
    console.log(`[FolloMe] Source tab ${tabId} closed`);
    sourceTabId = null;
  }
});

// ── Shortcut ──
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'start_listening' || command === 'START_ANALYSIS') {
    console.log('[FolloMe] Keyboard shortcut triggered');
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) {
      console.warn('[FolloMe] Shortcut — no active tab');
      return;
    }

    const tab = tabs[0];
    const { restricted, reason } = checkRestricted(tab.url);
    if (restricted) {
      console.warn(`[FolloMe] Shortcut — restricted page: ${reason} (url: ${tab.url}). Skipping.`);
      // Cannot show overlay on restricted pages, just log
      return;
    }

    sourceTabId = tab.id;
    const result = await safeSendMessage(tab.id, { type: 'ANALYZE_PAGE', question: '' });
    if (result) {
      console.log('[FolloMe] Shortcut trigger delivered successfully');
    } else {
      console.error('[FolloMe] Shortcut trigger failed to deliver to tab');
    }
  }
});

console.log('[FolloMe] Service worker initialized');
