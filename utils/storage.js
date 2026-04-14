/**
 * FolloMe — Storage Utility
 * Handles chrome.storage operations with a clean abstraction.
 * Generates anonymous user_id per install for analytics readiness.
 */

const FolloStorage = (() => {
  /**
   * Get value from chrome.storage.local
   */
  async function get(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] ?? null);
      });
    });
  }

  /**
   * Set value in chrome.storage.local
   */
  async function set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  /**
   * Remove key from chrome.storage.local
   */
  async function remove(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove([key], resolve);
    });
  }

  /**
   * Generate a UUID v4
   */
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Get or create anonymous user ID
   */
  async function getUserId() {
    let userId = await get('follome_user_id');
    if (!userId) {
      userId = generateUUID();
      await set('follome_user_id', userId);
    }
    return userId;
  }

  /**
   * Get stored events
   */
  async function getEvents() {
    return (await get('follome_events')) || [];
  }

  /**
   * Append event to stored events (capped at 500)
   */
  async function appendEvent(event) {
    const events = await getEvents();
    events.push(event);
    // Cap at 500 events to avoid storage bloat
    if (events.length > 500) {
      events.splice(0, events.length - 500);
    }
    await set('follome_events', events);
  }

  return { get, set, remove, getUserId, getEvents, appendEvent };
})();

// Make available globally for content scripts
if (typeof window !== 'undefined') {
  window.FolloStorage = FolloStorage;
}
