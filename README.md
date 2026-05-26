# Feishu Doc to Markdown

A Chrome extension that extracts Feishu/Lark document content and converts it to Markdown. All conversion happens entirely in the browser — no server or external services required.

## Features

- **One-click extraction** — Detects Feishu/Lark documents and extracts content with a single click
- **Block Model parsing** — Uses Feishu's internal block model for accurate conversion (with HTML+Turndown fallback)
- **Rich content support** — Headings, lists, code blocks, tables, images, quotes, callouts, TODOs, equations, mentions
- **Whiteboard & diagram capture** — Renders whiteboards and diagrams as PNG via canvas capture with CDP viewport expansion
- **Image preview** — Images display as base64 in preview while markdown source keeps original URLs
- **Markdown preview** — Opens a new tab with rendered Markdown (toggle between rendered and source view)
- **Save & copy** — Copy markdown to clipboard or save as `.md` file (supports File System Access API)
- **MUI powered UI** — Popup and preview pages built with React + Material UI

## Install

### From source

```bash
git clone https://github.com/everplus/chrome-lark-markdown.git
cd chrome-lark-markdown
npm install
npm run build
```

Then load the extension:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `dist/` directory

> First use will prompt "Extension wants to debug this browser" — click Allow. This is required for CDP viewport expansion to capture whiteboard content.

## Usage

1. Navigate to a Feishu/Lark document
2. Click the extension icon in the toolbar
3. The popup shows the document title and a **Extract & Convert** button
4. Click the button and wait for the conversion to complete
5. A preview tab opens automatically with the rendered Markdown

## Development

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Watch mode (auto-rebuild on file changes)
npm run dev
```

## Project Structure

```
├── background/service-worker.js   # Core logic: scroll, extract, convert, capture
├── content/content.js             # Content script: scroll loading, HTML extraction
├── src/popup/                     # Popup UI (React + MUI)
│   ├── main.jsx
│   └── App.jsx
├── src/preview/                   # Preview page (React + MUI)
│   ├── main.jsx
│   ├── App.jsx
│   └── markdown.css
├── lib/turndown.js                # HTML-to-Markdown fallback
├── icons/                         # Extension icons
├── vite.config.js                 # Build configuration
└── manifest.json                  # Extension manifest (MV3)
```

## How It Works

1. **Scroll to load** — Scrolls `.bear-web-x-container` to trigger lazy loading of all document content
2. **Extract content** — Accesses Feishu's internal `window.PageMain.blockManager` to traverse the block model tree, falling back to HTML + Turndown if unavailable
3. **Capture whiteboards** — Uses CDP `Emulation.setDeviceMetricsOverride` to expand the viewport beyond virtual scroll limits, then captures canvas elements as base64 PNG
4. **Fetch images** — Downloads HTTP images with page credentials and converts to base64 for preview display
5. **Open preview** — Stores markdown + image data in `chrome.storage.local` and opens a new tab with the rendered preview

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current tab |
| `tabs` | Query active tab, create preview tab |
| `scripting` | Inject scripts for content extraction |
| `storage` | Pass data between service worker and preview page |
| `debugger` | CDP viewport expansion for whiteboard capture |

## License

[MIT](LICENSE)
