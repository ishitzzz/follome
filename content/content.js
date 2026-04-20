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
      if (typeof FolloCursorGuide !== 'undefined' && message.steps) {
        if (typeof FolloCursorGuide.startGuidance === 'function') {
          FolloCursorGuide.startGuidance(message.steps);
        } else if (typeof FolloCursorGuide.processResponse === 'function') {
          FolloCursorGuide.processResponse(message.steps);
        }
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
