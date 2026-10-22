# iPadOS guide

OpenCraft runs on iPad mini, iPad Air and iPad Pro (11 and 13 inch) in Safari, or as a full-screen app
from the Home Screen. This guide covers the two modes, pairing with a desktop, the Apple Pencil, the
Magic Keyboard and the known limits.

## Two modes

OpenCraft picks the mode on its own, and the Status page (Settings, Status) shows which one is active.

| Mode | When | What works |
| :--- | :--- | :--- |
| **Home network (Wi-Fi)** | the desktop shares the IDE on Wi-Fi and the iPad is paired | everything: the desktop's projects, the real terminal, Git, Ollama on the desktop, all MCP tools |
| **Browser (offline)** | no desktop answers: on the road, or the PWA offline | the four apps, projects stored on the iPad in IndexedDB, the chat with your own API key, file import and export, the Apple Pencil in PdfCraft |

Projects of the two modes are kept apart. Move a project between them with ZIP export and import, or
use **Sync now** under Settings, Share and sync.

## Pair the iPad with your desktop

1. **On the desktop**, open Settings, **iPad and network** and switch on **Share on Wi-Fi**, then
   restart the backend. Or start it directly with:

   ```sh
   npm run dev:lan      # development
   npm run start:lan    # production build
   ```

   The backend then listens on your network and prints a pairing address such as
   `http://192.168.178.20:5175/pair?token=...`.
2. **On the iPad**, open that address once in Safari. You can also enter the desktop's IP address,
   port and access token under Settings, **iPad and network**, **Connect to desktop**.
3. From then on, `http://<your PC>:5175/ide/` opens the IDE with your desktop projects.
4. Optional: Share, **Add to Home Screen** gives a full-screen app without browser bars.

How it stays safe: the desktop itself works as before. Every other device needs the token, stored as
an `HttpOnly`, `SameSite=Strict` cookie for that address. A cookie only counts when the request comes
from the desktop's own address, so other web pages on the same Wi-Fi cannot use it. **Renew** in the
settings disconnects all paired devices. The network settings and the token can only be changed on the
desktop.

## Apple Pencil

OpenCraft separates pen, finger and mouse input (Pointer Events) and reads pressure, tilt, azimuth,
barrel roll and hover.

- **In the apps** the pencil works like a precise mouse: cell ranges and the fill handle in GridCraft,
  placing and reshaping vector shapes in DeckCraft and WordCraft, selecting text. A hover ring and a
  short trail in the app's color show where it will land.
- **PdfCraft pencil view** (`src/workspace/pdf-pen.ts`): sign, write notes, highlight and redact on
  the page with pressure and tilt. Applying writes the PDF into the project; PdfCraft shows the result
  without reloading. Redaction rebuilds the affected page as an image, so the covered text is removed
  from the file, not just hidden.
- **Fingers and palm**: a finger scrolls, a short tap clicks, a long press opens the context menu, two
  fingers zoom. Touches are ignored while the pencil writes or hovers.
- **Scribble** works in the chat input, search fields and the code editor, so handwriting becomes
  text. App canvases and drawing surfaces block it, so they get pencil input instead.

The apps have no drawing API of their own, so pressure and tilt shape the strokes in the PdfCraft
pencil view and the visual feedback, not ink inside the apps. Apple Pencil Pro squeeze and double tap
are not available to web pages.

## Magic Keyboard and trackpad

All shortcuts work with `Cmd`:

| Shortcut | Does |
| :--- | :--- |
| `Cmd+K` | command palette |
| `Cmd+J` | show or hide the chat |
| `Cmd+Shift+J` | Full Chat Mode |
| `Cmd+Shift+P` | float the focused panel (picture in picture) |
| `Cmd+Shift+K` | search the project |
| `Cmd+Shift+E` | project tree |
| `Cmd+Shift+F` | focus mode |
| `Cmd+Shift+Enter` | maximize |
| `Cmd+Shift+M` | minimize to the dock |
| `Alt+1` to `Alt+9` | jump to a panel |

Arrow keys, `Tab` and `Enter` move through the `@` and `/` menus. Without a hardware keyboard, the
header and the chat show quick buttons for the command palette, `@` and `/`.

## Screen, windows and keyboard

- **Retina at 1:1.** The apps' web builds sized their canvas in CSS pixels but rendered at the device
  pixel ratio, so on Retina screens their interface appeared twice as large. `public/craft-frame.js`
  runs inside each app before its WebAssembly module, lays the canvas out at physical size and scales
  it back, so sizes, sharpness and pointer positions are exact.
- **Stage Manager, Split View, Slide Over and rotation** resize the workspace without reloading the
  apps. Below 700 pixels width the project tree and the chat become drawers.
- **On-screen keyboard.** The workspace follows the visual viewport, so the chat, the `@` and `/`
  menus and the terminal stay above the keyboard.
- **Touch targets** are at least 44 by 44 pixels. Gutters between panels snap to 50:50, 70:30 and
  30:70 when you drag them with a finger or the pencil.

## Limits

- Over plain HTTP on the home network, Safari allows neither WebGPU nor service workers. The apps then
  start with WebGL2 and the IDE runs without an offline cache. HTTPS through your own reverse proxy
  brings both back.
- From a page served over HTTPS, Safari blocks plain HTTP requests to the home network. Sync from
  browser mode works when the IDE is opened over `http://`.
- In browser mode the terminal, Git and the AI's office tools (read-sheet, write-document,
  create-slide, the PDF tools) need the desktop.
- Browser mode has no protected key store. Keys stay in memory until a reload unless you choose to keep
  them in the browser after a warning. Use keys with a spending limit.

## Troubleshooting

| Problem | Try |
| :--- | :--- |
| The iPad cannot reach the desktop | Check that **Share on Wi-Fi** is on and the backend was restarted, both devices are on the same Wi-Fi, and the desktop firewall allows port 5175. Open the pairing link again. |
| The IDE opens in browser mode although the desktop runs | The pairing cookie is missing or was renewed. Open the pairing link from the desktop again. |
| An app looks blurry or twice as large | Reload the panel. If it persists, report it with your iPad model and iPadOS version. |
| Handwriting does not turn into text | Scribble works in text fields (chat, search, code editor), not on app canvases. |
