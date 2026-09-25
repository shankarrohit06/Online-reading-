# Reading Pencil

A Chrome extension that makes reading online feel like reading on paper with a pencil in hand.

- **Ruled lines**: a faint line runs under every line of text, like notebook paper, so your eyes can
  follow each row without drifting.
- **The pencil**: the word under your mouse pops out slightly larger (125% by default) with a soft
  highlight, marking your place the way a pencil tip would. The rest of the page never shifts.
- **Keyboard reading**: step through the text word by word or line by line without touching the mouse.

It is off everywhere until you switch it on for a site. After that, the site remembers the setting.

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

The toolbar icon shows an **ON** badge on tabs where it is active. The keyboard keys work only while the
extension is on for the page. They are ignored inside text boxes, so editing works as normal. If Alt+R
clashes with something, change it at `chrome://extensions/shortcuts` (the popup links there).

## Settings (toolbar popup)

- **Pencil size**: how much the word grows, from 110% to 200%.
- **Highlight**: yellow, green, blue, pink, or any custom color.
- **Ruled lines**: on or off. The color can match the page's text (works on dark sites) or be a custom
  color.
- **Line spacing**: the page's own spacing, or 1.5×, 1.8× or 2×. Extra space also stops the enlarged
  word from covering the lines above and below it.
- **Reading font**: keep the page's font, or switch to
  [Atkinson Hyperlegible](https://brailleinstitute.org/freefont), OpenDyslexic, or Verdana.

Settings apply instantly to open tabs and sync across your Chrome profile.

## How it works

- `extension/src/content/pencil.js` finds the word under the pointer with `caretPositionFromPoint` and
  `Intl.Segmenter`. It draws an enlarged copy of that word in an overlay above the page, so the page's
  own text is never modified.
- `extension/src/content/ruler.js` gives each block of text a notebook-line background, aligned to its
  line height. Switching off removes everything it added.
- `extension/src/content/main.js` turns both on or off per site and applies setting changes live.
- `extension/src/background.js` handles Alt+R and the ON badge. It also injects the scripts into tabs
  that were already open when the extension was installed.

Chrome doesn't allow extensions on its own pages (`chrome://…`, the Web Store) or inside its built-in PDF
viewer.

## Development

```sh
npm install      # installs Playwright (for tests only)
npm test         # loads the extension in Chromium and checks the pencil, keys, settings and clean-up
npm run icons    # re-renders the PNG icons from extension/icons/icon.svg
```

Test screenshots are written to `tests/output/`.

Fonts: Atkinson Hyperlegible and OpenDyslexic are bundled under the SIL Open Font License. Their license
texts are in `extension/fonts/`.
