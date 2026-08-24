# Agent Translate

A Chrome extension that connects to an **OpenAI-compatible API** for translation: selection translation, full-page translation, and PDF translation.

## Features

- **Selection translation**: select text to pop up a translation, with copy / Esc / click-away to dismiss.
- **Full-page translation**: translate the current page with one click, and restore the original with one click.
- **PDF translation**: built-in PDF reader with selection translation and a side-by-side bilingual view.
- **Multiple languages**: pick a target language from a dropdown.
- **Context menu**: right-click selected text to translate.

## Install

1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" and select this folder
4. Click the extension icon → "Settings" and fill in your API config

## Configuration

| Item | Description |
| --- | --- |
| Base URL | Your API address; `/v1` is enough — a full URL or bare domain also works |
| API Key | Your Bearer token |
| Model | e.g. `gpt-4o-mini`, `deepseek-chat` |
| Target language | The language to translate into |
| Temperature | 0–2; 0.2–0.4 recommended for translation |

The Base URL is auto-completed, e.g.:

- `https://api.openai.com` → `https://api.openai.com/v1/chat/completions`
- `https://api.openai.com/v1` → same
- Already ending in `/chat/completions` → used as-is

## Usage

### Selection translation

Select text on a page and the translation pops up; click "Copy" to copy it.

### Full-page translation

Click the extension icon → "Translate page". Click "Restore" to revert.

### PDF translation

Open it any of these ways:

1. Click the extension icon → "Open PDF translator" (auto-loads the current PDF if the tab is one);
2. Right-click any PDF link → "Open PDF with translator";
3. In the reader, click "Open file" or drag a PDF in.

> Scanned PDFs have no text layer, so selection translation is unavailable without OCR.

## FAQ

**Does it need network / API quota?** Yes — it calls the API you configured.

**Do I put my API key in the code?** No. The key is stored only in browser local storage, never in repo files.

**Why aren't inputs / code blocks translated?** On purpose: `input`/`textarea`/`code`/`pre` are skipped to avoid breaking interactive content.
