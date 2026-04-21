/**
 * FolloMe — Main Content Script
 */
(() => {
  const alreadyLoaded = !!window.__follomeContentLoaded;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'EXECUTE_GUIDANCE') {
      if (typeof FolloOverlay !== 'undefined' && message.explanation) {
        FolloOverlay.showResponse(message.explanation);
      }
      if (message.steps) {
        ProgressTracker.init(message.steps);
      }
      sendResponse({ status: 'executing' });
    } else if (message.type === 'REQUEST_SNAPSHOT' || message.type === 'GET_DOM_SNAPSHOT') {
      try {
        const elements = typeof ContextExtractor.getElementsForMapping === 'function' 
            ? ContextExtractor.getElementsForMapping() 
            : [];
        sendResponse({ 
            domSnapshot: { 
                elements: elements, 
                url: window.location.href 
            } 
        });
      } catch (e) {
        console.error('[FolloMe] Context extraction failed:', e);
        sendResponse({ domSnapshot: { elements: [], url: window.location.href } });
      }
    } else if (message.type === 'SHOW_RESPONSE') {
      if (typeof FolloOverlay !== 'undefined') FolloOverlay.showResponse(message.response);
      sendResponse({ status: 'shown' });
    } else if (message.type === 'SHOW_ERROR') {
      if (typeof FolloOverlay !== 'undefined') FolloOverlay.showError(message.error);
      sendResponse({ status: 'shown' });
    } else if (message.type === 'SHOW_LOADING') {
      if (typeof FolloOverlay !== 'undefined') FolloOverlay.showLoading(message.message || 'Processing...');
      sendResponse({ status: 'shown' });
    } else if (message.type === 'PING') {
      sendResponse({ status: 'alive' });
    }
    return true;
  });

  if (alreadyLoaded) return;
  window.__follomeContentLoaded = true;

  const ProgressTracker = {
    resolvedSteps: [],
    activeStepIndex: 0,
    activeListener: null,
    activeElement: null,
    activeEventType: null,

    init(steps) {
      if (typeof ContextExtractor !== 'undefined') {
        const elements = ContextExtractor.getUIElements();
        this.resolvedSteps = steps.map(s => {
          let targetElement = null;
          if (s.element && document.body.contains(s.element)) {
            targetElement = s.element;
          } else if (s.elementIdx !== undefined && s.elementIdx !== null) {
            targetElement = ContextExtractor.getElementByIndex(elements, s.elementIdx);
          } else if (s.elementSelector) {
            try { targetElement = document.querySelector(s.elementSelector); } catch (e) {}
          }
          return { ...s, targetElement };
        });
      } else {
        this.resolvedSteps = steps;
      }
      this.activeStepIndex = 0;
      this.renderCurrentStep();
    },

    renderCurrentStep() {
      if (this.activeElement && this.activeListener && this.activeEventType) {
        this.activeElement.removeEventListener(this.activeEventType, this.activeListener);
        this.activeListener = null;
        this.activeElement = null;
        this.activeEventType = null;
      }

      if (this.activeStepIndex >= this.resolvedSteps.length) {
        console.log('[FolloMe] ProgressTracker: All steps completed.');
        if (typeof FolloCursorGuide !== 'undefined' && typeof FolloCursorGuide.clearAll === 'function') {
          FolloCursorGuide.clearAll();
        }
        return;
      }

      const step = this.resolvedSteps[this.activeStepIndex];
      const targetElement = step.targetElement;

      if (!targetElement) {
        console.warn(`[FolloMe] ProgressTracker: No targetElement for step ${this.activeStepIndex}`);
        this.activeStepIndex++;
        this.renderCurrentStep();
        return;
      }

      this.activeElement = targetElement;

      if (typeof FolloCursorGuide !== 'undefined' && typeof FolloCursorGuide.startGuidance === 'function') {
        FolloCursorGuide.startGuidance([step]);
      }

      const tagName = targetElement.tagName;
      const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA';
      this.activeEventType = isInput ? 'blur' : 'click';

      this.activeListener = () => {
        console.log(`[FolloMe] Tracker observed interaction on step ${this.activeStepIndex}`);
        this.activeElement.removeEventListener(this.activeEventType, this.activeListener);
        this.activeListener = null;
        this.activeElement = null;
        this.activeEventType = null;

        chrome.runtime.sendMessage({
          type: 'STEP_OUTCOME',
          stepIndex: this.activeStepIndex,
          outcome: 'completed'
        });

        this.activeStepIndex++;
        this.renderCurrentStep();
      };

      this.activeElement.addEventListener(this.activeEventType, this.activeListener);
    }
  };

  const DOMStabilityMonitor = {
    _score: 0,
    _THRESHOLD: 30,
    _resetTimer: null,
    _trackedElements: new Set(),
  
    trackElements(elements) {
      DOMStabilityMonitor._trackedElements = new Set(elements);
    },
  
    scoreMutations(mutations) {
      let score = 0;
      for (const m of mutations) {
        if (m.type === 'characterData') continue;
        if (m.type === 'attributes' && m.attributeName === 'style') continue;
        if (m.type === 'attributes' && m.attributeName === 'class') {
          if (DOMStabilityMonitor._trackedElements.has(m.target)) { score += 15; continue; }
          continue;
        }
        if (m.type === 'attributes') {
          if (['disabled', 'hidden', 'aria-hidden', 'aria-disabled'].includes(m.attributeName)) {
            if (DOMStabilityMonitor._trackedElements.has(m.target)) { score += 20; continue; }
            score += 2; continue;
          }
          continue;
        }
        if (m.type === 'childList') {
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1) continue;
            if (DOMStabilityMonitor._trackedElements.has(node)) { score += 50; continue; }
            if (node.querySelector && [...DOMStabilityMonitor._trackedElements].some(el => node.contains(el))) {
              score += 50; continue;
            }
          }
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const interactiveCount = (node.matches?.('input,button,select,a,[role="button"]') ? 1 : 0) +
              (node.querySelectorAll?.('input,button,select,a,[role="button"]')?.length || 0);
            if (interactiveCount > 3) { score += 25; continue; }
            if (interactiveCount > 0) { score += 5; continue; }
          }
        }
      }
      return score;
    },
  
    onMutation(mutations) {
      const batchScore = DOMStabilityMonitor.scoreMutations(mutations);
      DOMStabilityMonitor._score += batchScore;
  
      clearTimeout(DOMStabilityMonitor._resetTimer);
      DOMStabilityMonitor._resetTimer = setTimeout(() => {
        if (DOMStabilityMonitor._score >= DOMStabilityMonitor._THRESHOLD) {
          chrome.runtime.sendMessage({
            type: 'DOM_SIGNIFICANT_CHANGE',
            score: DOMStabilityMonitor._score,
            affectsTrackedElements: DOMStabilityMonitor._score >= 50
          });
        }
        DOMStabilityMonitor._score = 0;
      }, 500);
    }
  };
  
  window.DOMStabilityMonitor = DOMStabilityMonitor;
  
  const hostname = window.location.hostname;
  const isAIPlatform = hostname.includes('chatgpt.com') || hostname.includes('claude.ai') || hostname.includes('gemini.google.com');

  if (!isAIPlatform) {
    const observer = new MutationObserver((muts) => DOMStabilityMonitor.onMutation(muts));
    if (document.body) {
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'aria-disabled']
      });
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        observer.observe(document.body, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-hidden', 'aria-disabled']
        });
      });
    }
  }

  if (typeof ContextExtractor !== 'undefined') {
    chrome.runtime.sendMessage({
      type: 'PAGE_READY',
      domSnapshot: ContextExtractor.extract()
    });
  }
})();
