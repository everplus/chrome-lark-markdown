/**
 * Feishu document content extraction script
 * Injected into Feishu pages to assist with content extraction
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCROLL_AND_LOAD') {
    scrollAndLoad()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'EXTRACT_HTML') {
    try {
      const html = extractBodyHtml();
      sendResponse({ success: true, html });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
});

/**
 * Scroll the page to trigger lazy loading until all content is loaded
 */
async function scrollAndLoad() {
  const container = document.querySelector('.bear-web-x-container');
  if (!container) return;

  let stableCount = 0;
  let lastHeight = container.scrollHeight;

  while (stableCount < 3) {
    container.scrollTop = container.scrollHeight;
    await new Promise(r => setTimeout(r, 1000));
    const newHeight = container.scrollHeight;
    if (newHeight === lastHeight) {
      stableCount++;
    } else {
      stableCount = 0;
      lastHeight = newHeight;
    }
  }

  container.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 300));
}

/**
 * Extract document body HTML (cleaned up)
 */
function extractBodyHtml() {
  const selectors = [
    '.doc-content',
    '.docx-container',
    '.wiki-content',
    '#doc-content',
    '.render-unit-wrapper',
    'article',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      return cleanHtml(el.innerHTML);
    }
  }

  return cleanHtml(document.body.innerHTML);
}

function cleanHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());
  doc.querySelectorAll('.zone-container, .toolbar, .sidebar, .comment-zone').forEach(el => el.remove());
  return doc.body.innerHTML;
}
