# Reading Pencil

A Chrome extension that makes reading online feel like reading on paper with a pencil in hand.

- **Ruled lines**: a faint line runs under every line of text, like notebook paper, so your eyes can
  follow each row without drifting.
- **The pencil**: the word under your mouse pops out slightly larger (125% by default) with a soft
  highlight, marking your place the way a pencil tip would. The rest of the page never shifts.
- **Room to grow**: while it's on, words and lines get a little extra space, sized to your pencil
  size, so the enlarged word never covers any other letter.
- **Keyboard reading**: step through the text word by word or line by line without touching the mouse.
- **Read aloud**: select some text and click the speaker button beside it (or press **Alt+S**).
  Chrome reads from there through the rest of the article, skipping menus, sidebars, footers and
  footnote markers, while the pencil follows the voice word by word and the current sentence is
  tinted. Click any word to jump there. A mini player at the bottom pauses, skips sentences, changes
  speed and stops.

It is off everywhere until you switch it on for a site; a short note on the page confirms each switch.
After that, the site remembers the setting (`www.example.com` and `example.com` count as one site).

A guide with a practice article and every voice to listen to opens when you first install it, and any
time from **Guide & practice** in the popup.

## Install

1. Download this repository (Code → Download ZIP, then unzip), or `git clone` it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the **`extension`** folder.
4. Pin Reading Pencil from the puzzle-piece menu so its icon stays in the toolbar.

To use it on local files (`file://`), open the extension's **Details** and turn on **Allow access to
file URLs**.

## Use

| Action                    | How                                                 |
| ------------------------- | --------------------------------------------------- |
| Turn on/off for this site | Click the toolbar icon → switch, or press **Alt+R** |
| Move the pencil           | Hover over any word                                 |
| Next / previous word      | **Alt+→** / **Alt+←**                               |
| Line below / above        | **Alt+↓** / **Alt+↑** (stays in the same column)    |
| Lift the pencil           | **Esc**                                             |
| Read aloud                | Select text → click the speaker, or **Alt+S**       |
| Read from the pencil      | Put the pencil on a word, then **Alt+S**            |
| Pause / resume            | **Alt+S**, or the middle player button              |
| Previous / next sentence  | **Alt+←** / **Alt+→** while reading                 |
| Jump to a word            | Click it while reading                              |
| Stop reading              | **Esc**, or ✕ in the player                         |

While reading, the page scrolls to keep the voice's word in view. Scroll away to look at something
else and it stops following; **Back to reading** in the player (or scrolling back to the word) picks it
up again.

The toolbar icon shows an **ON** badge on tabs where it is active. The keyboard keys work only while the
extension is on for the page. They are ignored inside text boxes, so editing works as normal. If Alt+R
clashes with something, change it at `chrome://extensions/shortcuts` (the popup links there).

## Settings (toolbar popup)

- **Pencil size**: how much the word grows, from 110% to 200%.
- **Highlight**: yellow, green, blue, pink, or any custom color.
- **Ruled lines**: on or off. The color can match the page's text (works on dark sites) or be a custom
  color.
- **Line spacing**: the page's own spacing, or 1.5×, 1.8× or 2×. (Lines are always spaced at least
  enough for the pencil size you chose.)
- **Reading font**: keep the page's font, or switch to
  [Atkinson Hyperlegible](https://brailleinstitute.org/freefont), OpenDyslexic, or Verdana.
- **Read aloud**: the voice (any voice Chrome has, grouped by language; "online" ones such as
  Chrome's Google voices send the text to Google to be spoken, the others stay on your computer), the
  speed from 0.5× to 2×, and a button to test the voice. The popup says whether the pencil can follow
  the chosen voice word by word or at an estimated pace.

Settings apply instantly to open tabs and sync across your Chrome profile.

## How it works

- `extension/src/content/pencil.js` finds the word under the pointer with `caretPositionFromPoint` and
  `Intl.Segmenter`. It draws an enlarged copy of that word in an overlay above the page, so the page's
  own text is never modified.
- `extension/src/content/ruler.js` gives each block of text a notebook-line background, aligned to its
  line height. It also adds the extra space between words and lines that the pencil size needs.
  Switching off removes everything it added.
- Before a word grows, the pencil measures the nearest letters on both sides and on the lines above and
  below, and slides the enlarged word into the free space. A very long word, or one squeezed in by the
  page (menus, code), grows a little less rather than cover anything. `tests/no-overlap.js` checks this
  for every word of the test page at every pencil size, font and browser zoom level.
- `extension/src/content/reader.js` splits the text from your selection onwards into sentences with
  `Intl.Segmenter` and sends them one at a time to `chrome.tts` in the background worker. Each word
  the voice reports moves the pencil; for voices that don't report words, the pencil moves at a pace
  estimated from the speed. The sentence tint uses the CSS Custom Highlight API, so the page itself
  is not changed.
- `extension/src/content/main.js` turns everything on or off per site, applies setting changes live,
  and removes itself cleanly if the extension is updated while the page is open. After an update, open
  tabs on switched-on sites get the new version automatically.
- `extension/src/welcome/` is the guide and practice page.
- `extension/src/background.js` handles Alt+R and the ON badge. It also injects the scripts into tabs
  that were already open when the extension was installed.

Chrome doesn't allow extensions on its own pages (`chrome://…`, the Web Store) or inside its built-in PDF
viewer.

## Development

```sh
npm install      # installs Playwright (for tests only)
npm test         # loads the extension in Chromium: pencil, keys, settings, read aloud, clean-up,
                 # and no overlaps (read aloud uses a stand-in voice, as test machines have none)
npm run icons    # re-renders the PNG icons from extension/icons/icon.svg
```

Test screenshots are written to `tests/output/`.

Fonts: Atkinson Hyperlegible and OpenDyslexic are bundled under the SIL Open Font License. Their license
texts are in `extension/fonts/`.
