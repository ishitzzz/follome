/**
 * FolloMe — Guidance State Engine (v3)
 *
 * Three exported components:
 *
 *   StepQueue        — Shared buffer between the SLOW brain layer (service worker)
 *                      and the FAST cursor layer (content script rAF loop).
 *                      Brain pushes resolved steps; cursor reads them synchronously.
 *
 *   GuidanceSession  — Single-writer state container owned by the service worker.
 *                      All mutations flow through mutate(). Content scripts receive
 *                      read-only projections via SESSION_STATE_UPDATE messages.
 *
 *   SyncController   — DOM versioning + operation locks. Ensures async pipelines
 *                      (Groq, recovery) never commit against stale DOM snapshots.
 *
 * Context: loaded by content scripts (via manifest content_scripts) AND
 * importable by the service worker (ES module with "type": "module").
 */

// ───────────────────────────────────────────────────────────────────────
//  StepQueue — Shared Buffer Between Layers
// ───────────────────────────────────────────────────────────────────────

class StepQueue {
  constructor() {
    this._steps = [];           // all steps (resolved or pending)
    this._resolvedUpTo = -1;    // index of last resolved step
    this._activeStep = 0;       // index cursor is currently on
  }

  /**
   * SLOW LAYER writes: Push resolved step data.
   * Called by service worker after Groq batch returns.
   * Non-blocking — cursor doesn't wait for this.
   *
   * @param {number} index — step index to resolve
   * @param {object} elementData — { elementIdx, confidence, resolvedVia, ... }
   */
  pushResolved(index, elementData) {
    this._steps[index] = {
      ...this._steps[index],
      ...elementData,
      status: 'resolved',
      resolvedAt: Date.now()
    };
    this._resolvedUpTo = Math.max(this._resolvedUpTo, index);
  }

  /**
   * FAST LAYER reads: Get the current step for cursor targeting.
   * Returns immediately — never blocks.
   * If step isn't resolved yet, returns a "pending" placeholder.
   *
   * @returns {object|null}
   */
  getCurrentStep() {
    const step = this._steps[this._activeStep];
    if (!step) return null;
    if (step.status !== 'resolved') {
      return { ...step, status: 'pending', element: null };
    }
    return step;
  }

  /**
   * FAST LAYER reads: Peek at the NEXT step for lookahead animation.
   * Cursor starts moving toward step N+1 BEFORE step N completes.
   *
   * @returns {object|null}
   */
  peekNext() {
    return this._steps[this._activeStep + 1] || null;
  }

  /**
   * How far ahead has the brain resolved?
   * Cursor uses this to know if it can lookahead or must wait.
   *
   * @returns {number} difference between last resolved index and active step
   */
  getResolvedAhead() {
    return this._resolvedUpTo - this._activeStep;
  }

  /**
   * Advance the active step index by one.
   */
  advance() {
    this._activeStep++;
  }

  /**
   * Get all currently resolved steps (for sending to content script).
   * @returns {Array}
   */
  getResolvedSteps() {
    return this._steps
      .filter(s => s && s.status === 'resolved')
      .map(s => {
        const { _element, ...safe } = s;
        return safe;
      });
  }

  /**
   * Initialize with pending steps (before any are resolved).
   * @param {Array} steps — normalized step objects
   */
  initPending(steps) {
    this._steps = steps.map((s, i) => ({
      ...s,
      index: i,
      status: 'pending'
    }));
    this._resolvedUpTo = -1;
    this._activeStep = 0;
  }

  /**
   * Serialize for message passing to content script.
   * @returns {object}
   */
  serialize() {
    return {
      steps: this._steps.map(s => {
        if (!s) return null;
        const { _element, ...safe } = s;
        return safe;
      }),
      resolvedUpTo: this._resolvedUpTo,
      activeStep: this._activeStep
    };
  }

  /**
   * Restore from serialized data (content script side).
   * @param {object} data
   */
  deserialize(data) {
    if (!data) return;
    this._steps = data.steps || [];
    this._resolvedUpTo = data.resolvedUpTo ?? -1;
    this._activeStep = data.activeStep ?? 0;
  }

  /**
   * Reset to empty state.
   */
  reset() {
    this._steps = [];
    this._resolvedUpTo = -1;
    this._activeStep = 0;
  }
}


// ───────────────────────────────────────────────────────────────────────
//  GuidanceSession — Cross-Layer State Consistency (Concern B)
// ───────────────────────────────────────────────────────────────────────

class GuidanceSession {
  /**
   * @param {number} [sourceTabId] — tab that receives projections
   */
  constructor(sourceTabId) {
    this._version = 0;              // increments on every mutation
    this._sourceTabId = sourceTabId || null;
    this._data = {
      sessionId: typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'idle',               // idle|normalizing|validating|mapping|recovering|executing|completed|failed
      domVersion: 0,
      teacherData: null,
      steps: [],
      currentStepIndex: -1,
      pipelineStage: null,          // which stage is currently running
      errors: [],
      timeline: []                  // audit log of every state transition
    };
  }

  /**
   * All state mutations go through this method.
   * Ensures: version increment, timeline logging, persistence, content script notification.
   *
   * @param {function} mutator — receives this._data, mutates it in-place
   * @param {string} reason — human-readable reason for the mutation
   */
  mutate(mutator, reason) {
    const prevVersion = this._version;
    const prevStatus = this._data.status;

    // Apply mutation
    mutator(this._data);

    // Increment version
    this._version++;

    // Log transition
    this._data.timeline.push({
      version: this._version,
      timestamp: Date.now(),
      reason,
      fromStatus: prevStatus,
      toStatus: this._data.status,
      pipelineStage: this._data.pipelineStage
    });

    // Cap timeline to prevent unbounded growth
    if (this._data.timeline.length > 200) {
      this._data.timeline = this._data.timeline.slice(-100);
    }

    // Persist to chrome.storage.session (async, non-blocking)
    this._persist();

    // Notify content script of state change (for overlay/cursor updates)
    this._notifyContentScript();
  }

  /**
   * Content script receives a READ-ONLY projection.
   * It cannot mutate state directly — only via messages to service worker.
   *
   * @returns {object}
   */
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
        elementSelector: s.elementSelector, // selector string, NOT DOM ref (can't serialize)
        elementIdx: s.elementIdx,
        hint: s.hint,
        groupId: s.groupId
      })),
      pipelineStage: this._data.pipelineStage,
      errorCount: this._data.errors.length,
      lastError: this._data.errors[this._data.errors.length - 1] || null
    };
  }

  /**
   * Persist session state to chrome.storage.session.
   * Async, fire-and-forget — does not block mutate().
   */
  async _persist() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) {
        await chrome.storage.session.set({
          'follome_session': {
            version: this._version,
            data: {
              ...this._data,
              // Strip non-serializable fields
              steps: this._data.steps.map(s => ({ ...s, _element: undefined }))
            }
          }
        });
      }
    } catch (e) {
      console.warn('[GuidanceSession] Persist failed:', e);
    }
  }

  /**
   * Push read-only projection to the content script on the source tab.
   * Async, fire-and-forget.
   */
  async _notifyContentScript() {
    if (this._sourceTabId) {
      try {
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          await chrome.tabs.sendMessage(this._sourceTabId, {
            type: 'SESSION_STATE_UPDATE',
            projection: this.getProjection()
          });
        }
      } catch { /* tab may be closed */ }
    }
  }

  /**
   * Set the source tab that receives state projections.
   * @param {number} tabId
   */
  setSourceTab(tabId) {
    this._sourceTabId = tabId;
  }

  /**
   * Get raw data (for debugging / advanced access).
   * @returns {object}
   */
  getData() {
    return this._data;
  }

  /**
   * Get current version.
   * @returns {number}
   */
  getVersion() {
    return this._version;
  }

  /**
   * Restore from chrome.storage.session after navigation/reload.
   * @returns {Promise<GuidanceSession|null>}
   */
  static async restore() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
        return null;
      }
      const stored = await chrome.storage.session.get('follome_session');
      if (!stored?.follome_session) return null;

      const session = new GuidanceSession();
      session._version = stored.follome_session.version;
      session._data = stored.follome_session.data;
      return session;
    } catch (e) {
      console.warn('[GuidanceSession] Restore failed:', e);
      return null;
    }
  }
}


// ───────────────────────────────────────────────────────────────────────
//  SyncController — DOM Versioning + Operation Locks (Gap 1)
// ───────────────────────────────────────────────────────────────────────

const SyncController = {
  _domVersion: 0,        // increments on every DOM scan
  _opLock: null,         // Promise that resolves when current pipeline completes
  _opAbort: null,        // AbortController for cancelling in-flight operations
  _pendingResolve: null, // resolves _opLock

  /**
   * Get the current DOM version.
   * @returns {number}
   */
  get domVersion() {
    return this._domVersion;
  },

  /**
   * Get the current AbortSignal (for passing to fetch calls).
   * @returns {AbortSignal|null}
   */
  get signal() {
    return this._opAbort ? this._opAbort.signal : null;
  },

  /**
   * Called by content.js MutationObserver on structural DOM change.
   * Increments version AND aborts any in-flight pipeline that used old DOM.
   *
   * @param {object} [mutationSummary] — optional metadata about the change
   */
  onDOMChanged(mutationSummary) {
    const oldVersion = this._domVersion;
    this._domVersion++;

    // Abort in-flight Groq/recovery calls bound to old version
    if (this._opAbort) {
      this._opAbort.abort();
      this._opAbort = null;
    }

    // Notify guidance engine to pause cursor immediately
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      try {
        chrome.runtime.sendMessage({
          type: 'DOM_VERSION_CHANGED',
          oldVersion,
          newVersion: this._domVersion,
          affectedSteps: this._getUnresolvedStepIndices()
        });
      } catch { /* extension context may be invalidated */ }
    }
  },

  /**
   * Wraps an entire resolve pipeline (normalize→validate→map→recover)
   * in a version-checked, abort-aware context.
   * Returns null if DOM changed mid-operation (caller must restart).
   *
   * @param {object} domSnapshot — the DOM state to operate against
   * @param {function} pipelineFn — async (domSnapshot, signal) => result
   * @returns {Promise<*|null>} — pipeline result, or null if invalidated
   */
  async runPipeline(domSnapshot, pipelineFn) {
    // Wait for any previous pipeline to finish or abort
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

      // CRITICAL: validate version before committing
      if (this._domVersion !== startVersion) {
        console.warn(`[Sync] DOM changed during pipeline (v${startVersion}→v${this._domVersion}). Discarding results.`);
        return null; // caller sees null → triggers re-scan + re-run
      }

      return result;
    } finally {
      this._pendingResolve?.();
      this._opLock = null;
      this._opAbort = null;
    }
  },

  /**
   * Get indices of steps that are not yet resolved.
   * Used when notifying about DOM version changes.
   * @returns {number[]}
   * @private
   */
  _getUnresolvedStepIndices() {
    // This will be populated when wired into the pipeline
    // For now returns empty — the service worker will determine affected steps
    return [];
  },

  /**
   * Reset to initial state.
   */
  reset() {
    if (this._opAbort) {
      this._opAbort.abort();
    }
    this._domVersion = 0;
    this._opLock = null;
    this._opAbort = null;
    this._pendingResolve = null;
  }
};


// ───────────────────────────────────────────────────────────────────────
//  Exports — dual mode: content script global + ES module
// ───────────────────────────────────────────────────────────────────────

// Content script global assignment
if (typeof window !== 'undefined') {
  window.StepQueue = StepQueue;
  window.GuidanceSession = GuidanceSession;
  window.SyncController = SyncController;
}
if (typeof self !== 'undefined') {
  self.StepQueue = StepQueue;
  self.GuidanceSession = GuidanceSession;
  self.SyncController = SyncController;
}

// ES module exports (service worker with "type": "module")
// Wrapped in try-catch for content script contexts where export is syntax error
try {
  if (typeof exports !== 'undefined') {
    exports.StepQueue = StepQueue;
    exports.GuidanceSession = GuidanceSession;
    exports.SyncController = SyncController;
  }
} catch { /* not a module context */ }
