# Chromium Reddit Scroll Limiter: Research & Architecture Guide

## Executive Summary

The original Reddit Scroll Limiter is Firefox-only, not because of technical limitations, but likely due to **developer preference and time constraints**. A Chromium version is entirely feasible and can be built using Manifest V3. Evidence shows similar scroll-limiting extensions exist on Chrome (e.g., "Stop Social Media Scrolling").

---

## Part 1: Why the Developer Didn't Make a Chrome Version

### Most Likely Reasons

1. **Developer Preference for Firefox**
   - Firefox's WebExtensions API offers more permissive access patterns
   - Smaller initial target audience (Firefox users are often more privacy-conscious)
   - Easier to publish on Firefox Add-ons with less review scrutiny

2. **Time/Resource Constraints**
   - Building for both platforms requires maintaining two codebases (though modern tools can reduce this)
   - Testing across browser differences adds complexity
   - The extension is relatively new (released January 2024) and may be a side project

3. **Manifest V3 Learning Curve** (for Chrome)
   - Chrome's MV3 is more restrictive than Firefox's approach
   - Requires understanding service workers vs background pages
   - More complex permissions model

4. **Market Size**
   - Reddit users often use Chrome, but niche productivity tools find good adoption on Firefox
   - Lower barrier to publication on Firefox means faster MVP

5. **No Explicit Technical Blocker**
   - The extension doesn't require APIs unavailable in MV3
   - Scroll detection, DOM manipulation, and modal display all work fine in Chrome
   - Similar extensions (Stop Social Media Scrolling, FiniteScroll) exist on Chrome

---

## Part 2: Technical Architecture for Chromium Version

### Core Functionality Requirements

1. **Monitor scroll position** on reddit.com
2. **Count posts** as user scrolls
3. **Display modal overlay** after N posts
4. **Block further scrolling/clicking** until user scrolls back up
5. **Persist user settings** (scroll limit number)

---

### Architecture Overview

```text
Chromium Reddit Scroll Limiter (MV3)
├── manifest.json           # Extension configuration
├── service-worker/
│   └── background.js       # Service worker (no persistent state)
├── content-scripts/
│   └── reddit-limiter.js   # Runs on reddit.com pages
├── popup/
│   ├── popup.html          # Settings UI
│   ├── popup.js            # Popup logic
│   └── popup.css           # Popup styling
└── storage/
    └── Stored in chrome.storage.sync
```

---

## Part 3: Detailed Implementation

### 3.1 manifest.json

```json
{
  "manifest_version": 3,
  "name": "Reddit Scroll Limiter",
  "version": "1.0",
  "description": "Stop endless Reddit scrolling with adjustable post limits",
  "permissions": [
    "storage",
    "scripting"
  ],
  "host_permissions": [
    "https://reddit.com/*",
    "https://www.reddit.com/*",
    "https://old.reddit.com/*"
  ],
  "background": {
    "service_worker": "service-worker/background.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": [
        "https://reddit.com/*",
        "https://www.reddit.com/*",
        "https://old.reddit.com/*"
      ],
      "js": ["content-scripts/reddit-limiter.js"],
      "run_at": "document_end"
    }
  ],
  "action": {
    "default_title": "Reddit Scroll Limiter",
    "default_popup": "popup/popup.html"
  },
  "icons": {
    "16": "images/icon-16.png",
    "32": "images/icon-32.png",
    "48": "images/icon-48.png",
    "128": "images/icon-128.png"
  }
}
```

**Key Points:**
- `manifest_version: 3` is required for modern Chrome
- `host_permissions` specifies which sites the extension can access
- Content scripts run at `document_end` (after DOM is loaded)
- Service worker replaces persistent background pages from MV2

---

### 3.2 Content Script: reddit-limiter.js

This is the core logic that runs on Reddit pages.

```javascript
// reddit-limiter.js - Content Script
// Runs on every reddit.com page in the user's tab

const REDDIT_SELECTORS = {
  // Works for new Reddit (redesign)
  post_new: 'div[data-testid="post-container"]',
  // Works for old Reddit
  post_old: '.thing.link, .thing.comment',
  // Works for old Reddit listings
  post_old_alt: '#siteTable > .thing'
};

class RedditScrollLimiter {
  constructor() {
    this.postCount = 0;
    this.isBlocked = false;
    this.scrollLimit = 100; // Default
    this.modalId = 'reddit-scroll-limiter-modal';
    
    this.init();
  }

  async init() {
    // Load user's settings from Chrome storage
    const settings = await this.getSettings();
    this.scrollLimit = settings.postLimit || 100;

    // Start monitoring
    this.setupScrollListener();
    this.setupPostObserver();
    this.attachModalStyles();
  }

  async getSettings() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: 'GET_SETTINGS' },
        (settings) => resolve(settings || {})
      );
    });
  }

  setupScrollListener() {
    // Throttle scroll events to avoid performance issues
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => this.onScroll(), 150);
    });
  }

  onScroll() {
    // If modal is visible and user scrolled back up, unlock
    if (this.isBlocked) {
      const scrollPos = window.scrollY;
      // If user scrolled back to top 50% of page, disable modal
      if (scrollPos < window.innerHeight * 0.5) {
        this.removeModal();
        this.isBlocked = false;
      }
    }
  }

  setupPostObserver() {
    // Use MutationObserver to detect new posts being added (infinite scroll)
    const observer = new MutationObserver((mutations) => {
      this.countPosts();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: false,
      attributes: false
    });
  }

  countPosts() {
    if (this.isBlocked) return; // Don't count if already blocked

    // Try all possible selectors
    let posts = 0;
    
    for (const selector of Object.values(REDDIT_SELECTORS)) {
      const found = document.querySelectorAll(selector).length;
      if (found > 0) {
        posts = Math.max(posts, found);
      }
    }

    this.postCount = posts;

    // Check if limit reached
    if (this.postCount >= this.scrollLimit && !this.isBlocked) {
      this.showModal();
      this.isBlocked = true;
    }
  }

  showModal() {
    // Remove existing modal if present
    this.removeModal();

    const modal = document.createElement('div');
    modal.id = this.modalId;
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    modal.innerHTML = `
      <div style="
        background: white;
        padding: 40px;
        border-radius: 12px;
        text-align: center;
        max-width: 500px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      ">
        <h2 style="margin: 0 0 20px 0; color: #333;">You've scrolled through ${this.postCount} posts!</h2>
        <p style="margin: 0 0 20px 0; color: #666; font-size: 16px;">
          Scroll back up to continue browsing, or take a break.
        </p>
        <p style="margin: 0; color: #999; font-size: 14px;">
          Limit set to ${this.scrollLimit} posts.
        </p>
      </div>
    `;

    document.body.appendChild(modal);

    // Prevent scrolling
    document.body.style.overflow = 'hidden';
  }

  removeModal() {
    const modal = document.getElementById(this.modalId);
    if (modal) {
      modal.remove();
      document.body.style.overflow = '';
    }
  }

  attachModalStyles() {
    // Inject any additional CSS needed
    const style = document.createElement('style');
    style.textContent = `
      #${this.modalId} * {
        box-sizing: border-box;
      }
    `;
    document.head.appendChild(style);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new RedditScrollLimiter();
  });
} else {
  new RedditScrollLimiter();
}
```

**Key Technical Points:**

1. **MutationObserver**: Detects when new posts are added (Reddit uses infinite scroll/dynamic loading)
2. **Scroll Throttling**: Prevents excessive function calls (150ms delay)
3. **Multiple Selectors**: Handles old Reddit, new Reddit, and mobile differences
4. **Message Passing**: Communicates with service worker to get settings
5. **DOM Manipulation**: Creates and removes modal overlay without requiring special APIs

---

### 3.3 Service Worker: background.js

MV3 requires a service worker instead of a persistent background page.

```javascript
// service-worker/background.js
// Handles installation and message passing

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default settings on first install
    chrome.storage.sync.set({
      postLimit: 100,
      enabled: true
    });
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_SETTINGS') {
    chrome.storage.sync.get(['postLimit', 'enabled'], (settings) => {
      sendResponse(settings);
    });
    return true; // Indicates we'll send response asynchronously
  }
});
```

**Why Service Worker Instead of Background Page?**
- MV3 requirement: more efficient (only runs when needed)
- Simpler resource management
- Better security model
- Automatic cleanup after messages are processed

---

### 3.4 Popup UI: popup.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reddit Scroll Limiter Settings</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="container">
    <h1>Reddit Scroll Limiter</h1>
    
    <div class="setting">
      <label for="postLimit">Post Limit:</label>
      <div class="input-group">
        <input type="number" id="postLimit" min="1" max="500" value="100">
        <span id="valueDisplay">100</span>
      </div>
      <input type="range" id="postLimitSlider" min="1" max="500" value="100" class="slider">
      <small>Scroll stops after this many posts</small>
    </div>

    <div class="setting">
      <label>
        <input type="checkbox" id="enabled" checked>
        Extension Enabled
      </label>
    </div>

    <button id="resetBtn" class="button-secondary">Reset to Default (100)</button>
    <div id="status" class="status"></div>
  </div>

  <script src="popup.js"></script>
</body>
</html>
```

---

### 3.5 Popup Logic: popup.js

```javascript
// popup/popup.js
// Handle popup interactions and settings

document.addEventListener('DOMContentLoaded', loadSettings);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(['postLimit', 'enabled']);
  document.getElementById('postLimit').value = settings.postLimit || 100;
  document.getElementById('postLimitSlider').value = settings.postLimit || 100;
  document.getElementById('valueDisplay').textContent = settings.postLimit || 100;
  document.getElementById('enabled').checked = settings.enabled !== false;
}

// Sync number input and slider
document.getElementById('postLimit').addEventListener('input', (e) => {
  const value = e.target.value;
  document.getElementById('postLimitSlider').value = value;
  document.getElementById('valueDisplay').textContent = value;
  saveSetting('postLimit', parseInt(value));
});

document.getElementById('postLimitSlider').addEventListener('input', (e) => {
  const value = e.target.value;
  document.getElementById('postLimit').value = value;
  document.getElementById('valueDisplay').textContent = value;
  saveSetting('postLimit', parseInt(value));
});

document.getElementById('enabled').addEventListener('change', (e) => {
  saveSetting('enabled', e.target.checked);
});

document.getElementById('resetBtn').addEventListener('click', () => {
  document.getElementById('postLimit').value = 100;
  document.getElementById('postLimitSlider').value = 100;
  document.getElementById('valueDisplay').textContent = 100;
  saveSetting('postLimit', 100);
  showStatus('Reset to default (100 posts)', 2000);
});

function saveSetting(key, value) {
  chrome.storage.sync.set({ [key]: value }, () => {
    showStatus(`✓ Saved: ${key} = ${value}`, 1500);
  });
}

function showStatus(message, duration = 2000) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.classList.add('show');
  setTimeout(() => status.classList.remove('show'), duration);
}
```

---

### 3.6 Popup Styles: popup.css

```css
/* popup/popup.css */

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: 350px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f8f9fa;
  color: #333;
}

.container {
  padding: 20px;
}

h1 {
  font-size: 18px;
  margin-bottom: 20px;
  color: #1f2937;
}

.setting {
  background: white;
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 15px;
  border: 1px solid #e5e7eb;
}

label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
  color: #374151;
}

.input-group {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

input[type="number"] {
  width: 70px;
  padding: 8px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}

#valueDisplay {
  font-size: 16px;
  font-weight: bold;
  color: #dc2626;
  min-width: 40px;
}

.slider {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: #e5e7eb;
  outline: none;
  -webkit-appearance: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #dc2626;
  cursor: pointer;
}

.slider::-moz-range-thumb {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #dc2626;
  cursor: pointer;
  border: none;
}

input[type="checkbox"] {
  margin-right: 8px;
  cursor: pointer;
}

small {
  display: block;
  font-size: 12px;
  color: #6b7280;
  margin-top: 8px;
}

.button-secondary {
  width: 100%;
  padding: 10px;
  background: #e5e7eb;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  color: #374151;
  transition: all 0.2s;
}

.button-secondary:hover {
  background: #d1d5db;
}

.status {
  margin-top: 15px;
  padding: 10px;
  background: #d1fae5;
  color: #065f46;
  border-radius: 6px;
  font-size: 13px;
  text-align: center;
  display: none;
}

.status.show {
  display: block;
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

---

## Part 4: Advanced Features to Add

### 4.1 Enhanced Features

```javascript
// Additional features for your improved version:

1. **Site-Specific Settings**
   - Allow different limits for different subreddits
   - Store: { 'r/AskReddit': 50, 'r/programming': 200, default: 100 }

2. **Time Tracking**
   - Show total time spent scrolling
   - Graph of daily usage patterns

3. **Smart Post Detection**
   - Count by vote count (skip low-quality posts)
   - Count by time (only count posts from last X hours)
   - Skip ads and promoted content

4. **Custom Messages**
   - Allow users to set custom motivational messages
   - Add emoji/GIFs in modal

5. **Session History**
   - Log scrolling sessions
   - Show "You've done this 5 times this week" warnings

6. **Break Reminders**
   - Suggest specific activities instead of just scrolling
   - Integration with external break/wellness apps

7. **Context-Aware Limiting**
   - Work mode vs leisure mode
   - Time-based limits (stricter during work hours)
   - Whitelist/blacklist specific subreddits

8. **Analytics Dashboard**
   - Weekly/monthly scrolling trends
   - Most visited subreddits
   - Export as CSV/JSON
```

---

## Part 5: Testing Checklist

- [ ] Test on old.reddit.com
- [ ] Test on new reddit.com (redesign)
- [ ] Test on reddit.com/r/[subreddit]
- [ ] Test comment threads (ensure it counts posts vs comments correctly)
- [ ] Test on mobile-responsive Reddit
- [ ] Verify modal appears at correct post count
- [ ] Verify modal disappears when scrolled back up
- [ ] Test settings persistence across page reloads
- [ ] Test settings sync across multiple devices (chrome.storage.sync)
- [ ] Test with infinite scroll enabled/disabled
- [ ] Performance: test on a very long Reddit thread (10k+ posts)
- [ ] Test uninstall/reinstall doesn't lose settings
- [ ] Cross-browser test on Edge, Opera, Brave (all Chromium-based)

---

## Part 6: Deployment Steps

### Step 1: Prepare Directory Structure

```text
reddit-scroll-limiter-chrome/
├── manifest.json
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── service-worker/
│   └── background.js
├── content-scripts/
│   └── reddit-limiter.js
└── popup/
    ├── popup.html
    ├── popup.js
    └── popup.css
```

### Step 2: Local Testing

1. Go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select your extension directory
5. Test thoroughly

### Step 3: Chrome Web Store Publishing

1. Create a Google Play Developer account ($5 one-time fee)
2. Package as `.zip` file
3. Upload to Chrome Web Store
4. Provide privacy policy
5. Screenshots and description
6. Wait for review (1-3 days)

---

## Part 7: Why Chromium is Viable

| Aspect | Firefox | Chrome MV3 | Viable? |
|--------|---------|-----------|---------|
| Scroll event listening | ✅ Full | ✅ Full | ✅ Yes |
| DOM manipulation | ✅ Full | ✅ Full | ✅ Yes |
| localStorage/IndexedDB | ✅ Full | ✅ Full | ✅ Yes |
| Message passing | ✅ Full | ✅ Full | ✅ Yes |
| Service workers | ✅ Supported | ✅ Recommended | ✅ Yes |
| Content scripts | ✅ Full | ✅ Full | ✅ Yes |
| Persistent background | ✅ Default | ⚠️ Deprecated | Handled by service worker |

**Conclusion**: All required functionality is supported in MV3. No blocker exists.

---

## Summary: Why No Chrome Version Exists

1. **Not a technical issue** - the extension uses only basic APIs available in Chrome
2. **Likely reasons**:
   - Developer's first project (published Jan 2024)
   - Firefox users as target audience
   - Wanted to ship MVP quickly
   - Didn't see market demand on Chrome yet

3. **Opportunity for you**:
   - Build the Chrome version with enhanced features
   - Market it as an improved version
   - Add features like analytics, subreddit-specific limits, time tracking
   - Publish on Chrome Web Store for larger audience

---

## Resources

- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/mv3-migration/)
- [Content Scripts API](https://developer.chrome.com/docs/extensions/mv3/content_scripts/)
- [chrome.storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
- [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
