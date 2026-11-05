# Changelog — My-Web V2.0.0

## Major redesign

- Removed the old generic “Zaytons Lil Land → Playground → UNO” flow.
- Added a card-themed start screen, press-anywhere interaction and a focused main menu.
- Added create-room/join-room modal flows with nickname and code validation.
- Redesigned the waiting lobby with room-code copy, player/host status and four house-rule switches.
- Added Settings for music and effects toggles/volume, plus reduced-motion preference persistence.
- Replaced the prior game styling with a table-first layout, oval green felt, layered pile UI, player badges, turn indicators, visible penalty/reaction states and responsive layouts.

## Cards and motion

- Increased playable-hand card size and redesigned the hand as an overlapping fan that can scroll on small screens.
- Kept card DOM elements stable between server updates instead of rebuilding the hand on every update.
- Added a fly-to-discard transition using perspective, skew and rotation when a played card leaves the hand.
- Added playable-card glow, dimmed non-playable cards, focus states, draw pile glow when no card is playable and emphasis for a newly drawn playable card.
- Added an atlas slicer for the selected classic PC texture sheet; art is user-supplied and not included in the ZIP.
- Added built-in SVG fallbacks so missing card crops do not break the game layout.

## Gameplay and multiplayer

- Implemented a server-validated UNO call state, a large animated UNO announcement and a catch window for missed calls.
- Catching a missed UNO adds two cards to the offender's hand and closes the challenge; duplicate/late catches are ignored.
- Added a Wild Draw Four challenge/accept flow and corresponding draw penalties.
- Kept the 108-card classic deck and the existing Stacking, 7–0, Draw Until Playable and 6 Reaction house rules.
- Added handling for card stacking, Wild color selection, drawn-playable-card pass, hand swapping and hand rotation.
- Added reconnect tokens for active games, a disconnect grace period and an automatic skip when a disconnected player's turn blocks the table.
- Added `/healthz` and meaningful dependency-free rule tests.

## Fixed / tightened

- Restored clear status/penalty feedback instead of hiding game messages.
- Centralized core rules in `lib/game-engine.js`.
- Added unique card IDs, allowing the client to track a card through hand and discard rendering.
- Added room and timer cleanup when players leave, including cancelling a pending 7-hand swap if its owner leaves.

## Notes

- This ZIP is a new V2 project build; it was not pushed to GitHub because a repository write connection was unavailable in the build environment. The `main` branch was not modified.
- Exact classic PC texture crops are not bundled because extracted game artwork does not have verified public redistribution rights in the referenced archive. Run `tools/slice_uno_texture.py` after locally adding the selected sheet.
- A complete real-time playtest still requires `npm install` and testing with multiple browser sessions.

## V3 table rework
- Game screen rebuilt as a PC-UNO-style playfield: opponents' face-down fans around the edges, draw/discard piles in the centre inside a direction ring tinted with the current colour, your hand fanned directly on the table (no tray/panel).
- Hand hover now resolved from layout, not transformed boxes: no flicker, no neighbour stealing hover; neighbours spread to reveal the lifted card. Hand is auto-sorted by colour/value; arrow keys + Enter work; on touch, first tap lifts and second tap plays.
- Popups removed: toasts/notices, banners, wild-colour modal, 6-reaction overlay and leave confirm are replaced by a single status line, seat bubbles (+N), contextual pills, an on-table colour wheel, a round TAP button and a two-tap leave. UNO catch is a CATCH! chip on the offender's seat.
- New `docs/game.css`; old game rules stripped from `docs/style.css`. Re-theme the table via `--bg-1/2/3` in `.field`.

## V4
- Splash, main menu and room rebuilt in the PC-UNO look: one rounded font (Baloo 2), red/orange rays, 3D floating cards, chunky skewed buttons, square avatars + blue nameplates, icon-only house rules. New `docs/menu.css`.
- Colour wheel is a thick 3D pie shown to every player (server relays `wildPicking`), including live slice highlight.
- UNO button restyled as an arcade/bomb-style hazard button; "UNO!" is now a 3D extruded effect with stars, placed in front of the caller and oriented the way the caller sees it.
- Draw pile is a real 12-card stack at the top-left of the table, rotated -45°. Turn text/counters trimmed; static files are served with no-cache.

## V6 — Ubisoft-style gameplay scene
- 16:9 logical stage (1280×720, portrait 560×1100) scaled uniformly; background fills extra space.
- Dark-crimson → red → orange/yellow environment, glossy elliptical tabletop with glowing rim and facets, floating squares/diamonds/fragments.
- Seat-based opponent fans (row / diagonal) from one generic renderer, with mirrored reflections; character avatars, coloured nameplates, white card-count badges; active player glows gold.
- Draw deck: thick 3D stack at upper-left, own clickable area. Discard: up to 7 layered cards. Big curved opposing arrows that flip with direction.
- Player hand: dynamic curved fan, layout-based hover (no flicker). Contextual UNO button, metallic gear; Leave moved into Settings; room code / YOUR TURN / back button removed from the table.

## V8 — real-card motion + fixes
- Animation director: every server update is played as an ordered scene (play → impact effect → each drawn card → new turn). Inputs lock while it runs; click anywhere to skip. Fixes the +2 "teleport" (play, draws and turn change used to be shown in one frame, and seats were rebuilt from scratch).
- Cards are 2-sided 3D objects: arcing flights, tilt from table plane, mid-air flip (draw → hand turns face-up, opponent plays turn face-up), exact landing in the reserved hand slot. Deal-in at round start (deck in the centre, one card at a time), then the deck glides to its corner.
- Persistent seats/fans (cards move instead of popping), slap on landing, burst effects for Skip / Reverse / +2 / Wild / +4, floating "+N" on the victim.
- 6 reaction: last tapper now draws 2 (and anyone who never taps), GO-moment lead-in with false-start guard, new electric-blue pulsing button with draining ring and shockwaves, ✓ badges on tapped players, "SLOWEST!" callout. Added test/six-reaction.test.js (needs socket.io-client).

## V9
- Normal / draw-until-playable draws no longer show "+N"; it only appears for penalties from enemy cards (+2, +4, taking a stacked penalty).
- Wild cards land as their black sprite; after the colour is chosen the matching colour sprite (new `docs/cards/WC_*.png`, `W4_*.png`, sliced from `assets/uno-classic-sheet.png`) fades in with a soft light sweep. Colour ring and white burst removed.
- Wild picker: circular wheel pops from the pile with squash & stretch; +4 uses four extruded blocks (OG style) that shoot up from the pile. Shown to all players (server relays `kind`).
- 6 rule: no timer. Everyone taps; the last tapper draws 2 automatically (hidden 15s safety net for AFK players). Button is locked (charging ring) until a server-synced GO, so nobody can tap instantly; client clocks are corrected with `serverNow`, which fixes the 1.5–2s late taps on non-host devices.
- 7 / 0: fixed hands being treated as draws (card values are numbers). New OG-style handover: hands gather into stacks, stacks travel to the new owner(s) (7: the two players; 0: every seat in play direction), then spread into fans. Server now sends `lastSwap` / `lastRotate`.

## V10
- Swap/rotate (7 / 0) animation: the card stack is now a persistent object that stays on screen through gather → travel → spread, so nothing blinks between stages.
- Wild cards: bigger landing (card slam, pile shake, spinning rainbow rays + four stars), then a colour-matched flash/rays (+ "+4" icon for Wild Draw Four) as the sprite recolors.
- Hand: grey and slightly lowered when it is not your turn; bright and slightly raised on your turn, playable cards get the same golden glow as the draw deck.
- +4 challenge restored: it is now offered on every fresh +4 (previously only with stacking off). With stacking on you may also answer with your own +4. Buttons: red Challenge / blue Decline. Added test/wild4-challenge.test.js.
