# prevueR
SparkNotes for film &amp; entertainment! Get previews &amp; summaries of your favorite media.

# prevueR: Chrome extension

prevueR previews movies, series, TV episodes, events and sports games. Each search gives you an AI summary plus YouTube trailers and clips. The UI is built from the Figma file "prevueR" (350 × 500 frame) in both its light and dark themes.

## Install (developer mode)
1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this `prevueR` folder.
3. Click the toolbar icon or press **Shift+Cmd+P** (Ctrl+Shift+P on Windows/Linux). prevueR opens in Chrome's side panel on the right of the window and stays open while you browse. You can change the shortcut under Settings › Shortcut.

## Set up the APIs (Settings › API's)
The first time you open prevueR, a **Welcome** screen asks for these keys, with links to where you get each one. You can skip it and add them later.

| Service | What to enter | Notes |
|---|---|---|
| AI summary | Provider + key | **LocalAI** is the default and needs no key. Run it at `http://localhost:8080` (or set Server URL). OpenAI, Claude, Gemini and Llama need your own API key. If you leave Model blank, prevueR picks one from the provider's model list. |
| Trailers & Clips | YouTube Data API v3 key | Get one in Google Cloud Console → enable "YouTube Data API v3". Each search uses about 100 quota units. |
| Watched | Trakt Client ID + username | Create an app at trakt.tv/oauth/applications. Watched reads the user's **public** Trakt history. |

Keys are stored only in `chrome.storage.local` on this device and are never synced.

## How it works
- **Home search** understands free text such as `How I Met Your Mother s3e21` or `season 3 episode 21`.
- **Auto Search / Autofill** reads the active tab: schema.org JSON-LD, Open Graph, Google result knowledge panels, IMDb, Wikipedia, YouTube, the major streaming players and sports sites. It fills in title, season, episode and type. If the tab has nothing usable, it falls back to the last title it detected.
- **History** stores every search with its summary and clips, so **View** reopens a past search without calling the APIs again. **Full History** scrolls through all of them.
- **Watched** pages through Trakt history as you scroll. **View** runs a fresh prevueR search for that title.
- **Trailers & Clips play inside prevueR.** Click a thumbnail to play it in the popup. Cmd/Ctrl-click opens it on YouTube instead. YouTube's player won't load without an HTTP Referer, so `background.js` installs a `declarativeNetRequest` rule that adds one to player frames opened by prevueR. Embeds on other sites are not affected.
- **Side panel.** Drag the panel's left edge to resize it. The 350 × 500 design scales to fit the panel and stretches to fill any extra space.
- **Autofill on any tab.** The first time you use Auto Search or Autofill, Chrome asks for permission to read pages. Without it, Autofill can only read the tab where you opened prevueR.
- API failures and missing keys show the centered **ERROR** dialog from the design.

## Files
- `manifest.json`: MV3 manifest, shortcut, permissions
- `popup/`: UI shown in the side panel (`popup.html`, `popup.css`, `popup.js`)
- `lib/`: `ai.js` (providers), `youtube.js`, `trakt.js`, `autofill.js` (page scraping), `storage.js`, `media.js`
- `assets/`: icons and logo exported from Figma; `fonts/`: Poppins and Inter (Latin subset, bundled)

## To confirm before publishing
- The FAQ link points to `https://atitaninc.com/prevuer/faq`, which is a placeholder. Change `LINKS.faq` in `popup/popup.js` if the URL differs.
- Watched uses public Trakt profiles. Private profiles would need Trakt OAuth (device-code flow), which isn't included yet.
