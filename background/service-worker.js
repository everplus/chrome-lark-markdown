/**
 * Background Service Worker
 * Core flow: scroll to load → extract content → convert to Markdown → open preview
 */

importScripts('../lib/turndown.js');

const BREADCRUMB_SELECTOR = '.wiki-suite-title__inner-wrapper > :first-child > :last-child .breadcrumb-container-item__text';
const FALLBACK_BREADCRUMB_SELECTOR = '.note-title__input-and-star .breadcrumb-container-item :first-child :last-child, .note-title__input-and-star .note-title__input :first-child';

// In-memory preview store, keyed by preview tab ID
const previewStore = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  previewStore.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'EXTRACT_AND_CONVERT') {
    handleExtractAndConvert()
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        notifyPopup('ERROR', { error: err.message });
        sendResponse({ error: err.message });
      });
    return true;
  }
  if (msg.type === 'GET_PREVIEW_DATA') {
    sendResponse(previewStore.get(msg.tabId) || null);
    return false;
  }
});

async function handleExtractAndConvert() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found');
  const tabId = tab.id;

  // Step 1: Scroll to load full content
  notifyPopup('PROGRESS', { step: 'step-scroll', state: 'active' });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
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
    },
  });
  notifyPopup('PROGRESS', { step: 'step-scroll', state: 'done' });

  // Step 2: Extract content
  notifyPopup('PROGRESS', { step: 'step-extract', state: 'active' });

  // Extract title
  const [titleResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (primary, fallback) => {
      let breadcrumbs = Array.from(document.querySelectorAll(primary)).map(i => i.textContent).filter(Boolean);
      if (breadcrumbs.length === 0) {
        breadcrumbs = Array.from(document.querySelectorAll(fallback)).map(x => x.textContent).filter(Boolean);
      }
      const clean = (s) => s.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim();
      return breadcrumbs.length > 0 ? clean(breadcrumbs[breadcrumbs.length - 1]) : '';
    },
    args: [BREADCRUMB_SELECTOR, FALLBACK_BREADCRUMB_SELECTOR],
  });
  const title = titleResult?.result || '';

  // Prefer Feishu internal Block Model extraction
  let markdown = null;
  try {
    const [blockResult] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractBlockModelMarkdown,
    });
    markdown = blockResult?.result;
  } catch (_) {}

  // Fallback: HTML + Turndown
  if (!markdown) {
    const [htmlResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Try multiple selectors
        const selectors = [
          '.page-main .page-main-item',
          '.doc-content',
          '.docx-container',
          '.wiki-content',
          '#doc-content',
          '.render-unit-wrapper',
          'article',
        ];
        let el = null;
        for (const sel of selectors) {
          el = document.querySelector(sel);
          if (el) break;
        }
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll(
          '[class*="comment"], [class*="Comment"], ' +
          '[class*="sidebar"], [class*="Sidebar"], ' +
          '[class*="recommend"], [class*="Recommend"], ' +
          '[class*="backlink"], [class*="Backlink"], ' +
          '[class*="quote-item"], ' +
          '.doc-footer, .doc-aside, ' +
          '[class*="add-icon"], [class*="add-cover"], ' +
          'nav, footer, [role="complementary"], ' +
          'style, script, [contenteditable="false"]'
        ).forEach(e => e.remove());
        return clone.innerHTML;
      },
    });

    const html = htmlResult?.result || '';
    if (html) {
      const turndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
      });

      turndown.addRule('cleanup', {
        filter: ['span'],
        replacement: (content) => content.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, ''),
      });

      turndown.addRule('removeEmpty', {
        filter: (node) => {
          if (node.nodeName === 'A' && node.getAttribute('href') === 'javascript:void(0)') return true;
          if (node.nodeName === 'IMG' && (node.getAttribute('src') || '').startsWith('data:')) return true;
          return false;
        },
        replacement: () => '',
      });

      markdown = turndown.turndown(html);
      markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  notifyPopup('PROGRESS', { step: 'step-extract', state: 'done' });

  if (!markdown) {
    throw new Error('Failed to extract document content');
  }

  // Step 3: Assemble final Markdown
  notifyPopup('PROGRESS', { step: 'step-convert', state: 'active' });
  const cleanTitle = (title || '').replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '').trim();
  const finalMarkdown = cleanTitle ? `# ${cleanTitle}\n\n${markdown}` : markdown;
  notifyPopup('PROGRESS', { step: 'step-convert', state: 'done' });

  // Step 4: Fetch images as base64 (preview only, does not modify markdown source)
  let imageDataMap = {};

  // Extract all image URLs, split into http (fetch) and feishu:// (canvas capture)
  const allUrls = extractAllImageUrls(finalMarkdown);
  const httpUrls = allUrls.filter(u => u.startsWith('http'));
  const feishuCanvasUrls = allUrls.filter(u => u.startsWith('feishu://'));

  // 4a: Fetch http images
  if (httpUrls.length > 0) {
    try {
      const [imgResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: fetchImagesAsBase64,
        args: [httpUrls],
      });
      const httpMap = imgResult?.result || {};
      Object.assign(imageDataMap, httpMap);
    } catch (_) {}
  }

  // 4b: Capture whiteboard/diagram canvas
  if (feishuCanvasUrls.length > 0) {
    try {
      // Expand viewport via CDP to bypass virtual scrolling and force-render all content
      const [sizeResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const el = document.documentElement;
          const container = document.querySelector('.bear-web-x-container');
          const extra = container ? Math.max(container.scrollHeight - container.offsetHeight, 0) : 0;
          return {
            width: el.clientWidth,
            height: el.clientHeight + extra + 60,
          };
        },
      });
      const { width, height } = sizeResult?.result || {};
      if (width && height) {
        try { await chrome.debugger.detach({ tabId }); } catch (_) {}
        await chrome.debugger.attach({ tabId }, '1.3');
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await new Promise(r => setTimeout(r, 2000));
      }

      const [canvasResult] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: captureCanvasImages,
      });

      // Restore viewport
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride');
      } catch (_) {}
      try {
        await chrome.debugger.detach({ tabId });
      } catch (_) {}

      const canvasData = canvasResult?.result || {};
      const canvasImages = canvasData.images || {};

      // Separate base64 from http URLs
      const needFetch = [];
      for (const [k, v] of Object.entries(canvasImages)) {
        if (v.startsWith('data:')) {
          imageDataMap[k] = v;
        } else if (v.startsWith('http')) {
          needFetch.push({ key: k, url: v });
        }
      }

      // Fetch remaining URLs in page context
      if (needFetch.length > 0) {
        const urls = needFetch.map(i => i.url);
        const [fetchResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: fetchImagesAsBase64,
          args: [urls],
        });
        const fetched = fetchResult?.result || {};
        for (const item of needFetch) {
          if (fetched[item.url]) {
            imageDataMap[item.key] = fetched[item.url];
          }
        }
      }

    } catch (_) {}
  }

  // Step 5: Store and open preview
  notifyPopup('PROGRESS', { step: 'step-preview', state: 'active' });
  const previewTab = await chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') });
  previewStore.set(previewTab.id, {
    markdown: finalMarkdown,
    title: cleanTitle || 'Feishu Doc',
    images: imageDataMap,
  });
  notifyPopup('PROGRESS', { step: 'step-preview', state: 'done' });
  notifyPopup('DONE', {});
}

/**
 * Block Model → Markdown conversion, runs in Feishu page MAIN world
 * Called via chrome.scripting.executeScript({ world: 'MAIN' })
 */
function extractBlockModelMarkdown() {
  const root = window.PageMain?.blockManager?.rootBlockModel;
  if (!root) return null;

  // Build username map
  const userNames = {};
  try {
    const userMap = window.DATA?.clientVars?.data?.user_map || {};
    for (const [uid, info] of Object.entries(userMap)) {
      const name = info?.display_name?.value || info?.name || '';
      if (name) userNames[uid] = name;
    }
  } catch (_) {}

  const T = {
    PAGE: 'page', TEXT: 'text',
    HEADING1: 'heading1', HEADING2: 'heading2', HEADING3: 'heading3',
    HEADING4: 'heading4', HEADING5: 'heading5', HEADING6: 'heading6',
    HEADING7: 'heading7', HEADING8: 'heading8', HEADING9: 'heading9',
    BULLET: 'bullet', ORDERED: 'ordered', CODE: 'code',
    QUOTE_CONTAINER: 'quote_container', TODO: 'todo',
    IMAGE: 'image', DIVIDER: 'divider', TABLE: 'table', CELL: 'table_cell',
    GRID: 'grid', CALLOUT: 'callout',
    IFRAME: 'iframe', SYNCED_REFERENCE: 'synced_reference', SYNCED_SOURCE: 'synced_source',
    GRID_COLUMN: 'grid_column', QUOTE: 'quote',
  };

  const HEADING_TYPES = new Set([T.HEADING1, T.HEADING2, T.HEADING3, T.HEADING4, T.HEADING5, T.HEADING6, T.HEADING7, T.HEADING8, T.HEADING9]);
  const TEXT_TYPES = new Set([...HEADING_TYPES, T.TEXT]);

  const orderedCounters = {};

  function getContent(block) {
    const zs = block.zoneState || block._zoneState;
    return zs?.content?.ops || [];
  }

  function opsToMd(ops) {
    if (!ops || !ops.length) return '';
    const parts = [];
    for (const op of ops) {
      if (op.attributes?.fixEnter) continue;
      let text = op.insert || '';

      if (op.attributes?.['inline-component']) {
        try {
          const comp = JSON.parse(op.attributes['inline-component']);
          if (comp.type === 'mention_doc') {
            text = `[${comp.data?.title || ''}](${comp.data?.raw_url || ''})`;
            parts.push(text);
            continue;
          }
          if (comp.type === 'url_preview') {
            const t = comp.data?.title || '';
            const u = comp.data?.raw_url || '';
            parts.push(t && u ? `[${t}](${u})` : (t || u));
            continue;
          }
          if (comp.type === 'user') {
            const uid = comp.data?.uid || '';
            const userName = userNames[uid] || comp.data?.name || '';
            parts.push(userName ? '@' + userName : '');
            continue;
          }
          const title = comp.data?.title || comp.data?.text || comp.data?.name || comp.data?.content || '';
          if (title) {
            parts.push(title);
            continue;
          }
        } catch (_) {}
      }

      if (op.attributes?.inlineCode) {
        parts.push('`' + text + '`');
        continue;
      }
      if (op.attributes?.equation) {
        parts.push('$$' + op.attributes.equation.replace(/\n$/, '') + '$$');
        continue;
      }

      if (op.attributes?.bold) text = '**' + text + '**';
      if (op.attributes?.italic) text = '*' + text + '*';
      if (op.attributes?.strikethrough) text = '~~' + text + '~~';
      if (op.attributes?.link) text = '[' + text + '](' + decodeURIComponent(op.attributes.link) + ')';

      parts.push(text);
    }
    return parts.join('');
  }

  function flatChildren(children) {
    const result = [];
    for (const child of children) {
      if (TEXT_TYPES.has(child.type)) {
        result.push(child, ...flatChildren(child.children || []));
      } else if (child.type === T.SYNCED_SOURCE) {
        result.push(...flatChildren(child.children || []));
      } else if (child.type === T.SYNCED_REFERENCE) {
        const refChildren = child.innerBlockManager?.rootBlockModel?.children || child.children || [];
        result.push(...flatChildren(refChildren));
      } else {
        result.push(child);
      }
    }
    return result;
  }

  function blockToMd(block, indent) {
    if (indent === undefined) indent = 0;
    const prefix = '  '.repeat(indent);
    let md = '';

    switch (block.type) {
      case T.PAGE:
        return flatChildren(block.children || []).map(c => blockToMd(c, indent)).join('\n\n');

      case T.HEADING1: case T.HEADING2: case T.HEADING3:
      case T.HEADING4: case T.HEADING5: case T.HEADING6: {
        const depth = parseInt(block.type.replace('heading', ''), 10);
        const hashes = '#'.repeat(depth);
        md = prefix + hashes + ' ' + opsToMd(getContent(block));
        break;
      }
      case T.HEADING7: case T.HEADING8: case T.HEADING9: {
        md = prefix + opsToMd(getContent(block));
        break;
      }
      case T.TEXT: {
        const text = opsToMd(getContent(block));
        if (!text.trim()) return '';
        md = prefix + text;
        break;
      }
      case T.BULLET: {
        const text = opsToMd(getContent(block));
        const subBlocks = flatChildren(block.children || []).map(c => blockToMd(c, indent + 1)).filter(Boolean).join('\n');
        md = prefix + '- ' + text;
        if (subBlocks) md += '\n' + subBlocks;
        break;
      }
      case T.ORDERED: {
        const text = opsToMd(getContent(block));
        const key = String(indent);
        const seq = block.snapshot?.seq;
        let num;
        if (seq && seq !== 'auto') {
          num = parseInt(seq, 10) || 1;
          orderedCounters[key] = num;
        } else {
          orderedCounters[key] = (orderedCounters[key] || 0) + 1;
          num = orderedCounters[key];
        }
        orderedCounters[String(indent + 1)] = 0;
        const subBlocks = flatChildren(block.children || []).map(c => blockToMd(c, indent + 1)).filter(Boolean).join('\n');
        md = prefix + num + '. ' + text;
        if (subBlocks) md += '\n' + subBlocks;
        break;
      }
      case T.TODO: {
        const text = opsToMd(getContent(block));
        const checked = block.snapshot?.done ? 'x' : ' ';
        md = prefix + '- [' + checked + '] ' + text;
        break;
      }
      case T.CODE: {
        const lang = block.language || '';
        const zs = block.zoneState || block._zoneState;
        const code = (zs?.allText || '').replace(/\n$/, '');
        md = prefix + '```' + lang.toLowerCase() + '\n' + code + '\n```';
        break;
      }
      case T.QUOTE_CONTAINER:
      case T.CALLOUT: {
        const children = flatChildren(block.children || []).map(c => blockToMd(c, 0)).filter(Boolean).join('\n\n');
        md = children.split('\n').map(l => '> ' + l).join('\n');
        break;
      }
      case T.IMAGE: {
        const alt = block.snapshot?.image?.caption?.text?.initialAttributedTexts?.ops?.[0]?.insert || block.snapshot?.image?.name || '';
        const token = block.snapshot?.image?.token || '';
        // Try to get actual image URL from DOM
        let imgSrc = '';
        const blockId = String(block.blockId || block.id || '');
        if (blockId) {
          const blockEl = document.querySelector('[data-block-id="' + blockId + '"]');
          if (blockEl) {
            const img = blockEl.querySelector('img[src]');
            if (img) {
              const src = img.getAttribute('src');
              if (src && src.startsWith('http')) imgSrc = src;
            }
          }
        }
        if (!imgSrc && token) {
          const domain = window.location.hostname.split('.').slice(-2).join('.');
          imgSrc = 'https://internal-api-drive-stream.' + domain + '/space/api/box/stream/download/preview/' + token + '/?preview_type=16';
        }
        md = prefix + '![' + alt + '](' + (imgSrc || '') + ')';
        break;
      }
      case T.DIVIDER: {
        md = prefix + '---';
        break;
      }
      case T.TABLE: {
        const snap = block.snapshot || {};
        const colCount = (snap.columns_id && snap.columns_id.length) || 0;
        const cellChildren = (block.children || []).filter(c => c && c.type === T.CELL);
        if (colCount <= 0 || cellChildren.length === 0) break;

        const rows = [];
        for (let r = 0; r < cellChildren.length; r += colCount) {
          const rowCells = cellChildren.slice(r, r + colCount);
          const rowStr = rowCells.map(cell => {
            const cellLines = flatChildren(cell.children || []).map(c => blockToMd(c, 0)).filter(Boolean);
            return (cellLines.join(' ') || ' ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
          });
          rows.push(rowStr);
        }
        if (rows.length === 0) break;

        const header = rows[0];
        const sep = header.map(() => '---');
        const body = rows.slice(1);
        const lines = ['| ' + header.join(' | ') + ' |', '| ' + sep.join(' | ') + ' |'];
        for (const row of body) {
          lines.push('| ' + row.join(' | ') + ' |');
        }
        md = lines.join('\n');
        break;
      }
      case T.IFRAME: {
        const src = block.snapshot?.src || block.snapshot?.url || '';
        if (src) md = prefix + '[Link](' + src + ')';
        break;
      }
      case 'file': {
        const fileName = block.snapshot?.file?.name || block.snapshot?.name || '';
        const token = block.snapshot?.file?.token || '';
        md = prefix + (fileName ? '[' + fileName + '](feishu://file/' + token + ')' : '');
        break;
      }
      case 'whiteboard': {
        const wbTitle = block.snapshot?.whiteboard?.title || 'Whiteboard';
        const token = block.snapshot?.whiteboard?.token || block.snapshot?.token || '';
        md = prefix + '![' + wbTitle + '](feishu://whiteboard/' + token + ')';
        break;
      }
      case 'diagram': {
        const dgTitle = block.snapshot?.diagram?.title || 'Diagram';
        const token = block.snapshot?.diagram?.token || block.snapshot?.token || '';
        md = prefix + '![' + dgTitle + '](feishu://diagram/' + token + ')';
        break;
      }
      default:
        return '';
    }
    return md;
  }

  try {
    const markdown = blockToMd(root);
    return markdown
      .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (err) {
    console.error('[MD] Block Model conversion failed:', err);
    return null;
  }
}

// === Utility functions ===

function notifyPopup(type, data) {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
}

/**
 * Extract all image URLs from markdown (http and feishu://)
 */
function extractAllImageUrls(markdown) {
  const urls = [];
  const regex = /!\[.*?\]\((.*?)\)/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    if (match[1]) urls.push(match[1]);
  }
  return urls;
}

/**
 * Fetch images in Feishu page context and convert to base64
 * Called via chrome.scripting.executeScript, takes an array of image URLs
 */
async function fetchImagesAsBase64(urls) {
  const result = {};
  const MAX_SIZE = 2 * 1024 * 1024;

  for (const url of urls) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      if (blob.size > MAX_SIZE) continue;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      result[url] = dataUrl;
    } catch (_) {}
  }
  return result;
}

/**
 * Traverse block model and capture whiteboard/diagram canvas as base64
 * Runs in Feishu page MAIN world. Requires CDP viewport expansion beforehand.
 */
async function captureCanvasImages() {
  const images = {};
  const root = window.PageMain?.blockManager?.rootBlockModel;
  if (!root) return { images };

  const targets = [];
  function collectTokens(node) {
    if (node.type === 'whiteboard' || node.type === 'diagram') {
      const blockId = String(node.blockId || node.id || '');
      const token = node.snapshot?.whiteboard?.token
        || node.snapshot?.diagram?.token
        || node.snapshot?.token || '';
      targets.push({ type: node.type, blockId, token });
    }
    if (node.innerBlockManager?.rootBlockModel?.children) {
      for (const child of node.innerBlockManager.rootBlockModel.children) collectTokens(child);
    }
    if (node.children) {
      for (const child of node.children) collectTokens(child);
    }
  }
  collectTokens(root);

  for (const t of targets) {
    if (!t.token) continue;
    const prefix = t.type === 'whiteboard' ? 'feishu://whiteboard/' : 'feishu://diagram/';
    const urlKey = prefix + t.token;

    const blockEl = document.querySelector('[data-block-id="' + t.blockId + '"]');
    if (blockEl) {
      blockEl.scrollIntoView({ behavior: 'instant', block: 'center' });
      await new Promise(r => setTimeout(r, 1500));

      const canvas = document.querySelector('[data-block-id="' + t.blockId + '"] .whiteboad-x-content-canvas canvas');
      if (canvas) {
        try {
          const data = canvas.toDataURL('image/png');
          if (data && data.length > 100) {
            images[urlKey] = data;
            continue;
          }
        } catch (_) {}
      }
    }

    // Fallback: drive stream API
    const domain = window.location.hostname.split('.').slice(-2).join('.');
    const apiUrl = 'https://internal-api-drive-stream.' + domain + '/space/api/box/stream/download/preview/' + t.token + '/?preview_type=16';
    images[urlKey] = apiUrl;
  }

  return { images };
}
