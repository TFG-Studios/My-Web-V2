# My-Web UNO — V2

A major V2 rebuild of the My-Web browser UNO clone. It keeps the lightweight stack — Node.js, Express, Socket.IO, vanilla HTML/CSS/JavaScript — and focuses on a game-first visual design, physical-feeling card motion, private online rooms, house rules and server-validated UNO calls.

> **Asset note:** The exact classic PC UNO texture sheet selected for this project is extracted game artwork hosted by The Textures Resource. It is deliberately not bundled in this ZIP because the archive page does not establish redistribution permission. The project includes a slicing tool; you can add the sheet locally and generate the individual card PNGs. Before publishing those extracted PNGs in a public repository or production build, check the rights and licence terms. The UI still works without them using the built-in fallback card rendering. A separate, original UNO-inspired PNG badge is included for the dramatic UNO-call animation; it is not presented as an official Mattel logo.

## What changed in V2

- Replaced the generic multi-step landing page with a branded start screen and focused main menu.
- Added dedicated create/join room modal flows, a redesigned waiting room, player states and host-only house-rule switches.
- Added local settings for background music, sound effects, volumes and reduced motion. Procedural Web Audio cues are used so no third-party audio files are required.
- Rebuilt the table around an oval felt surface, larger draw/discard piles, visible turn state, opponent badges, card counts, active-player highlights and mobile/landscape layouts.
- Added preserved DOM card elements and a flight animation for played cards; cards tilt, skew and rotate as they travel to the pile.
- Added playable-card glow, dimmed unplayable cards, a draw-pile highlight when no card can be played, and a distinct drawn-card state.
- Added a server-managed UNO call: the UNO button is highlighted with two cards, the player calls before their play, a large UNO graphic appears, and other players can catch a missed call for a two-card penalty before the next action (up to six seconds, so the 6 Reaction overlay does not consume the whole opportunity).
- Added Wild Draw Four challenge/accept flow, valid Wild colour picking, 7–0 hand rules, stacking, draw-until-playable and the 6 Reaction.
- Added session-token reconnection, disconnect grace, automatic turn skipping for disconnected players, room cleanup and an HTTP health endpoint.
- Added a Node test suite for deck composition and core rule helpers.

## Requirements

- Node.js 18 or newer.
- npm.
- Python 3.10+ and Pillow only if you want to slice the texture sheet. Install Pillow with `python -m pip install Pillow`.

## Run it locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. For a second player, open the same address in another browser/device on the same network, or deploy the server somewhere both devices can reach.

For development with automatic Node restart:

```bash
npm run dev
```

## Add the selected classic PC texture sheet

1. Open [The Textures Resource — Cards (Classic)](https://textures.spriters-resource.com/pc_computer/uno/asset/374167/).
2. Download the 2048 × 2048 PNG texture sheet and save it as `public/assets/uno-classic-sheet.png`.
3. Install Pillow if needed: `python -m pip install Pillow`.
4. Run from the project root:

   ```bash
   python tools/slice_uno_texture.py
   ```

   Or, from npm:

   ```bash
   npm run slice-cards -- --input public/assets/uno-classic-sheet.png
   ```

5. Inspect the generated crops in `public/cards/`. The crop coordinates are based on the visible 12-column atlas layout and are intentionally adjustable through script flags. Check a few number and action cards, then regenerate with adjusted `--x-start`, `--y-start`, `--x-step`, `--y-step`, `--cell-width` or `--cell-height` values if needed.
6. Refresh the browser. The frontend looks for `R0.png`–`R9.png`, `RS.png`, `RR.png`, `RA2.png` and equivalent `Y*`, `G*`, `B*` files, plus `WC.png`, `W4.png` and `BACK.png`. If a crop is absent, it automatically renders a local fallback face.

The atlas coordinates in the script are measured against the 1000-pixel preview of the 2048-pixel texture and scaled to the actual source image dimensions. Because atlas crops are approximate, inspect the outputs before using them in a release. The current project fallback card back remains an original SVG in `public/assets/card-back.svg`; the player backs are designed to switch to the extracted card back when the browser image set is present.

## Tests and validation

```bash
npm test
node --check server.js
node --check public/client.js
node --check lib/game-engine.js
```

The game server needs the two npm dependencies installed to run. The engine unit tests are dependency-free once Node.js is available.

## Architecture

```text
server.js                 Express + Socket.IO rooms and authoritative multiplayer events
lib/game-engine.js        Deck, turn helpers and shared legality checks
public/index.html         Splash, menu, setup modal, lobby, table and overlays
public/style.css          Full theme, responsive layouts, card motion and VFX
public/client.js          Socket client, rendering, animation, audio and UI state
tools/slice_uno_texture.py  Local atlas-to-card PNG slicer
test/game-engine.test.js  Node built-in test suite
```

## Known limitations

- The atlas itself is not included in this ZIP; individual extracted card PNGs are generated locally from a source file supplied by the user.
- The slicer uses fixed grid coordinates measured from the published preview. The atlas may require a small crop adjustment; inspect the generated files.
- Generated card PNGs are intentionally ignored by Git so an unlicensed extracted texture pack is not accidentally committed to a public fork.
- Room state is in memory. If the Node process restarts, active rooms are lost; a persistent database would be needed for durable rooms.
- The multiplayer UI and events are code-checked here, but a full live playtest requires installing npm dependencies and running multiple browser sessions.

## Credits and rights

- Original repository: [Zayton76/My-Web](https://github.com/Zayton76/My-Web)
- Selected reference texture sheet: [The Textures Resource — Cards (Classic)](https://textures.spriters-resource.com/pc_computer/uno/asset/374167/)
- UNO and related card designs are associated with their respective rights holders. This fan project is not affiliated with or endorsed by Mattel or Ubisoft. The texture download and generated crops are not included; users are responsible for confirming their rights to use them.
