'use strict';

(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const COLOR_LABELS = { red: 'RED', yellow: 'YELLOW', green: 'GREEN', blue: 'BLUE' };
  const COLOR_HEX = { red: '#ee3a2c', yellow: '#f2b705', green: '#25a85a', blue: '#2379d6' };
  const LETTERS = { red: 'R', yellow: 'Y', green: 'G', blue: 'B' };
  const DEFAULT_PREFS = { musicEnabled: true, musicVolume: 25, sfxEnabled: true, sfxVolume: 65, reduceMotion: false };
  const STORAGE_KEY = 'myweb-uno-v2-preferences';
  const TOKEN_KEY = 'myweb-uno-v2-session';

  let state = null;
  let roomCode = '';
  let setupMode = 'create';
  let pendingWildCardId = null;
  let lastUnoAnimationId = null;
  let lastWinnerShown = null;
  let lastAnimatedCardId = null;
  let lastDiscardVisualId = null;
  let unoChallengeTicker = null;
  let lastNoticeId = null;
  let reactionTicker = null;
  let musicTicker = null;
  let musicStep = 0;
  let audioContext = null;
  let lastGameSnapshot = null;
  let layout = null;
  let hoverIndex = -1;
  let armedId = null;
  let handView = { cards: [], els: [] };
  let discardStack = [];
  let discardRound = null;
  let lastTopId = null;
  let prevCounts = new Map();
  let flightThisRender = 0;
  let statusOverrideUntil = 0;
  let flashTimer = null;
  let leaveTimer = null;
  let lastPointerType = 'mouse';
  let pendingWildKind = 'wild';
  let clockOffset = 0;
  const clockSamples = [];
  let sixGoTimer = null;
  // Server time, estimated from the freshest low-latency sample (fixes tap windows on devices whose clocks differ).
  const srvNow = () => Date.now() + clockOffset;
  function syncClock(serverNow) {
    if (typeof serverNow !== 'number') return;
    clockSamples.push(serverNow - Date.now());
    if (clockSamples.length > 10) clockSamples.shift();
    clockOffset = Math.max(...clockSamples);
  }
  let prefs = loadPrefs();

  function makeToken() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
  let sessionToken = localStorage.getItem(TOKEN_KEY) || makeToken();
  localStorage.setItem(TOKEN_KEY, sessionToken);

  function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') }; }
    catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    document.documentElement.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
    updateAudioControls();
  }

  function showScreen(id) {
    ['splashScreen', 'mainMenu', 'lobbyScreen', 'gameScreen'].forEach(screenId => {
      $(screenId).classList.toggle('is-hidden', screenId !== id);
    });
    document.body.dataset.screen = id;
  }
  function openModal(id) { $(id)?.classList.remove('is-hidden'); }
  function closeModal(id) { $(id)?.classList.add('is-hidden'); }
  function hideAllModals() {
    ['roomSetupModal', 'settingsModal', 'howToPlayModal'].forEach(closeModal);
    closeWildWheel();
    pendingWildCardId = null;
  }

  function toast(text, kind = 'info') {
    if (!text) return;
    const item = document.createElement('div');
    item.className = `toast toast-${kind}`;
    item.innerHTML = `<span class="toast-mark">${kind === 'warning' || kind === 'penalty' ? '!' : kind === 'success' || kind === 'win' ? '✓' : '✦'}</span><span></span><button type="button" aria-label="Dismiss">×</button>`;
    item.querySelector('span:nth-child(2)').textContent = text;
    item.querySelector('button').addEventListener('click', () => item.remove());
    $('toastStack').appendChild(item);
    requestAnimationFrame(() => item.classList.add('toast-in'));
    window.setTimeout(() => {
      item.classList.remove('toast-in');
      window.setTimeout(() => item.remove(), 250);
    }, kind === 'warning' || kind === 'penalty' ? 5200 : 3400);
    $('globalLiveRegion').textContent = text;
  }

  function initAudio() {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioContext = new AudioContextClass();
    }
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  }
  function tone(frequency, duration = 0.11, wave = 'sine', volume = 0.08, delay = 0) {
    if (!audioContext || !prefs.sfxEnabled || prefs.sfxVolume <= 0) return;
    const now = audioContext.currentTime + delay;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * prefs.sfxVolume / 100), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }
  function playSfx(type) {
    initAudio();
    const clips = {
      card: [[660, .07, 'triangle', .07], [890, .08, 'sine', .045, .035]],
      draw: [[440, .09, 'triangle', .055], [350, .12, 'sine', .035, .045]],
      action: [[220, .16, 'sawtooth', .045], [330, .18, 'triangle', .04, .07]],
      uno: [[523, .14, 'triangle', .07], [784, .16, 'triangle', .07, .10], [1046, .22, 'sine', .055, .22]],
      error: [[190, .13, 'square', .035], [155, .16, 'square', .03, .1]],
      win: [[523, .17, 'triangle', .065], [659, .18, 'triangle', .065, .12], [784, .22, 'triangle', .07, .24], [1046, .3, 'sine', .06, .38]],
      reaction: [[880, .08, 'square', .035], [660, .08, 'square', .035, .1]],
      click: [[580, .045, 'sine', .035]],
    };
    (clips[type] || clips.click).forEach(([freq, duration, wave, volume, delay = 0]) => tone(freq, duration, wave, volume, delay));
  }
  function startMusic() {
    initAudio();
    if (!prefs.musicEnabled || prefs.musicVolume <= 0 || !audioContext || musicTicker) return;
    const notes = [196, 246.94, 293.66, 246.94, 220, 261.63, 329.63, 261.63];
    musicTicker = window.setInterval(() => {
      if (!prefs.musicEnabled || prefs.musicVolume <= 0 || !audioContext) return;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = notes[musicStep % notes.length];
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.014 * prefs.musicVolume / 25, now + .12);
      gain.gain.exponentialRampToValueAtTime(.0001, now + .62);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + .65);
      musicStep += 1;
    }, 620);
  }
  function stopMusic() {
    if (musicTicker) window.clearInterval(musicTicker);
    musicTicker = null;
  }
  function updateAudioControls() {
    $('musicEnabled').checked = Boolean(prefs.musicEnabled);
    $('sfxEnabled').checked = Boolean(prefs.sfxEnabled);
    $('musicVolume').value = String(prefs.musicVolume);
    $('sfxVolume').value = String(prefs.sfxVolume);
    $('reduceMotion').checked = Boolean(prefs.reduceMotion);
    $('musicVolumeValue').value = `${prefs.musicVolume}%`;
    $('musicVolumeValue').textContent = `${prefs.musicVolume}%`;
    $('sfxVolumeValue').value = `${prefs.sfxVolume}%`;
    $('sfxVolumeValue').textContent = `${prefs.sfxVolume}%`;
    if (!prefs.musicEnabled || prefs.musicVolume === 0) stopMusic();
    else if (audioContext && !musicTicker) startMusic();
  }

  const WILD_SUFFIX = { red: 'R', yellow: 'Y', green: 'G', blue: 'B' };
  function cardFile(card, wildColor) {
    if (!card) return null;
    if (card.color === 'wild') {
      const base = card.value === 'Wild4' ? 'W4' : 'WC';
      return WILD_SUFFIX[wildColor] ? `${base}_${WILD_SUFFIX[wildColor]}.png` : `${base}.png`;
    }
    const prefix = LETTERS[card.color];
    if (!prefix) return null;
    const value = card.value === 'Skip' ? 'S' : card.value === 'Reverse' ? 'R' : card.value === 'Draw2' ? 'A2' : card.value;
    return `${prefix}${value}.png`;
  }
  function cardSymbol(value) {
    if (value === 'Skip') return '⊘';
    if (value === 'Reverse') return '↻';
    if (value === 'Draw2') return '+2';
    if (value === 'Wild4') return '+4';
    if (value === 'Wild') return '✦';
    return value;
  }
  function cardLabel(card) {
    if (!card) return '';
    if (card.value === 'Wild4') return 'Wild Draw Four';
    if (card.value === 'Wild') return 'Wild';
    if (card.value === 'Draw2') return `${card.color} Draw Two`;
    return `${card.color || 'Wild'} ${card.value}`;
  }
  function createCardElement(card, options = {}) {
    const el = document.createElement(options.interactive ? 'button' : 'div');
    el.className = `playing-card card-${card.color}`;
    el.dataset.cardId = card.id || '';
    el.setAttribute('aria-label', cardLabel(card));
    if (options.interactive) {
      el.type = 'button';
      // Mouse/touch are handled by the hand container (see hitTestHand); this only serves keyboard activation.
      el.addEventListener('click', event => { if (event.detail === 0) onCardChosen(card, el); });
    }
    const filename = cardFile(card, options.wildColor);
    if (filename) {
      const image = document.createElement('img');
      image.className = 'card-face-image';
      image.src = `/cards/${filename}`;
      image.alt = '';
      image.draggable = false;
      image.addEventListener('error', () => {
        image.remove();
        if (!el.querySelector('.card-face-fallback')) el.appendChild(makeFallbackFace(card));
      }, { once: true });
      el.appendChild(image);
    } else el.appendChild(makeFallbackFace(card));
    return el;
  }
  function makeFallbackFace(card) {
    const face = document.createElement('span');
    face.className = 'card-face-fallback';
    const corner = document.createElement('span');
    corner.className = 'card-corner card-corner-top';
    corner.textContent = cardSymbol(card.value);
    const oval = document.createElement('span');
    oval.className = 'card-oval';
    const center = document.createElement('strong');
    center.textContent = cardSymbol(card.value);
    const bottom = document.createElement('span');
    bottom.className = 'card-corner card-corner-bottom';
    bottom.textContent = cardSymbol(card.value);
    face.append(corner, oval, center, bottom);
    if (card.color === 'wild') face.classList.add('fallback-wild');
    return face;
  }
  function makeCardBack() {
    const back = document.createElement('div');
    back.className = 'playing-card card-back';
    const img = document.createElement('img');
    img.src = '/cards/BACK.png';
    img.alt = 'Face-down UNO card';
    img.draggable = false;
    img.addEventListener('error', () => { img.src = '/assets/card-back.svg'; }, { once: true });
    back.appendChild(img);
    return back;
  }

  function activateTextureCardBack() {
    const probe = new Image();
    probe.onload = () => {
      const deckImage = $('drawPile')?.querySelector('img');
      if (deckImage) deckImage.src = '/cards/BACK.png';
      document.documentElement.classList.add('has-atlas-card-back');
    };
    probe.src = '/cards/BACK.png';
  }

  function localCanPlay(card, game, hand) {
    if (!state || !game || game.winnerId || game.sixReaction?.active || game.awaitingSwapPlayerId || game.pendingWild4) return false;
    if (game.pendingDraw > 0) {
      if (game.pendingType === 'Draw2' && card.value === 'Draw2') return true;
      if (game.pendingType === 'Wild4' && card.value === 'Wild4') return true;
      if (!state.settings.stacking) return false;
      if (game.pendingType === 'Draw2' && card.value === 'Wild4') return true;
      return (card.value === 'Skip' || card.value === 'Reverse') && (card.color === game.color || card.value === game.pendingType);
    }
    if (game.drawnPlayableCardId && card.id !== game.drawnPlayableCardId) return false;
    if (card.color === 'wild') return true;
    const top = game.top;
    return card.color === game.color || card.value === top?.value;
  }

  /* ------------------------------------------------------------------
     Field layout — card/avatar sizes are derived from the viewport and
     published as CSS custom properties on #field (see game.css).
  ------------------------------------------------------------------- */
  const clampNum = (min, value, max) => Math.max(min, Math.min(max, value));

  // Logical canvases: everything in #stage is laid out in these units and scaled uniformly (--s).
  const SIZES = {
    landscape: { w: 1280, h: 720, handW: 120, handH: 185, pad: 24, oppW: 62, oppH: 96, pileW: 122, pileH: 188, deckW: 100, deckH: 154, av: 92 },
    portrait: { w: 560, h: 1100, handW: 100, handH: 154, pad: 20, oppW: 46, oppH: 71, pileW: 92, pileH: 142, deckW: 78, deckH: 120, av: 66 },
  };
  // Seat anchors in % of the stage (hand centre + info panel centre). One generic renderer uses these.
  const SEAT_CFG = {
    landscape: {
      top: { hand: [50, 16], panel: [70, 14], kind: 'row' },
      left: { hand: [18, 48], panel: [8, 33], kind: 'diag', side: -1 },
      right: { hand: [80, 50], panel: [90, 33], kind: 'diag', side: 1 },
      tl: { hand: [38, 14], panel: [21, 13], kind: 'row', max: 190 },
      tr: { hand: [62, 14], panel: [79, 13], kind: 'row', max: 190 },
    },
    portrait: {
      top: { hand: [44, 12], panel: [80, 10], kind: 'row' },
      left: { hand: [20, 36], panel: [14, 25], kind: 'diag', side: -1 },
      right: { hand: [80, 36], panel: [86, 25], kind: 'diag', side: 1 },
      tl: { hand: [36, 11], panel: [14, 10], kind: 'row', max: 110 },
      tr: { hand: [64, 11], panel: [86, 10], kind: 'row', max: 110 },
    },
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function makeAvatarSvg(index) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#av${((index % 5) + 5) % 5}`);
    svg.appendChild(use);
    return svg;
  }

  function layoutField() {
    const field = $('field'), stage = $('stage');
    if (!field || !stage) return;
    const vw = field.clientWidth, vh = field.clientHeight;
    if (!vw || !vh) return;
    const portrait = vh > vw * 1.05;
    const d = portrait ? SIZES.portrait : SIZES.landscape;
    const s = Math.min(vw / d.w, vh / d.h);
    const set = (key, value) => stage.style.setProperty(key, value);
    set('--sw', `${d.w}px`); set('--sh', `${d.h}px`); set('--s', String(s));
    set('--hand-w', `${d.handW}px`); set('--hand-h', `${d.handH}px`); set('--hand-pad', `${d.pad}px`);
    set('--opp-w', `${d.oppW}px`); set('--opp-h', `${d.oppH}px`); set('--pile-w', `${d.pileW}px`); set('--pile-h', `${d.pileH}px`);
    set('--deck-w', `${d.deckW}px`); set('--deck-h', `${d.deckH}px`); set('--av', `${d.av}px`);
    stage.classList.toggle('is-portrait', portrait);
    layout = { ...d, s, vw, vh, portrait };
  }
  function relayout() {
    if (!state?.started || !state.game) return;
    layoutField();
    if (curView) renderOpponents(curView);
    applyHandTransforms();
  }

  /* ------------------------------------------------------------------
     Small helpers: in-place status line (replaces stacked toasts),
     flying cards, deterministic pile rotation.
  ------------------------------------------------------------------- */
  function hashId(id) {
    let h = 2166136261;
    for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const discardRot = id => (hashId(id) % 29) - 14;
  const centerOf = rect => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

  function flash(text, ms = 1700) {
    const el = $('tableMessage');
    if (!el || !text) return;
    statusOverrideUntil = Date.now() + ms;
    el.textContent = text;
    el.className = 'status-line is-flash';
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { statusOverrideUntil = 0; if (state?.game) renderStatus(state); }, ms);
    $('globalLiveRegion').textContent = text;
  }

  /* ------------------------------------------------------------------
     Real-card flights. A flying card is a 2-sided 3D object: it arcs through the air,
     tilts from the table plane to the viewer, can flip face-down → face-up mid-flight and
     lands exactly on its destination slot (the slot is rendered hidden until it lands).
  ------------------------------------------------------------------- */
  const FLY_P = 1000;
  const ABORT = Symbol('abort');
  const director = { queue: [], running: false, skip: false, gen: 0, anims: new Set(), shown: null, view: null };
  const sleep = ms => (director.skip || ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms)));
  const FAST = () => director.skip || prefs.reduceMotion || document.hidden;

  function flyCard({ card = null, back = false, from, to, flip = null, duration = 650, delay = 0, arc = -70, spin = 0 }) {
    if (FAST() || !from || !to) return Promise.resolve();
    const wrap = document.createElement('div');
    wrap.className = 'fly3d';
    wrap.style.cssText = `width:${from.w}px;height:${from.h}px;left:${from.x - from.w / 2}px;top:${from.y - from.h / 2}px;`;
    const inner = document.createElement('div');
    inner.className = 'fly-inner';
    const front = card ? createCardElement(card) : makeCardBack();
    front.classList.add('fly-face', 'front');
    const rear = makeCardBack();
    rear.classList.add('fly-face', 'rear');
    inner.append(front, rear);
    wrap.appendChild(inner);
    $('cardFlightLayer').appendChild(wrap);
    const dx = to.x - from.x, dy = to.y - from.y, s = to.w / from.w;
    const fr = from.rot || 0, tr = (to.rot || 0) + spin, ft = from.tilt || 0, tt = to.tilt || 0;
    const T = (x, y, t, r, sc) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) perspective(${FLY_P}px) rotateX(${t.toFixed(1)}deg) rotateZ(${r.toFixed(1)}deg) scale(${sc.toFixed(3)})`;
    const dist = Math.hypot(dx, dy);
    const lift = 1 + Math.min(0.3, dist / 2400 + 0.12);
    const motion = wrap.animate([
      { transform: T(0, 0, ft, fr, 1), easing: 'cubic-bezier(.32,0,.4,1)' },
      { transform: T(dx * 0.55, dy * 0.55 + arc, ((ft + tt) / 2) * 0.4, fr + (tr - fr) * 0.55, ((1 + s) / 2) * lift), offset: 0.55, easing: 'cubic-bezier(.2,.7,.25,1)' },
      { transform: T(dx, dy, tt, tr, s) },
    ], { duration, delay, fill: 'both' });
    director.anims.add(motion);
    if (flip) {
      const a = flip === 'toFront' ? 'rotateY(180deg)' : 'rotateY(0deg)', b = flip === 'toFront' ? 'rotateY(0deg)' : 'rotateY(180deg)';
      const turn = inner.animate([{ transform: a }, { transform: b }], { duration: duration * 0.72, delay, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
      director.anims.add(turn);
      turn.finished.catch(() => {}).then(() => director.anims.delete(turn));
    } else if (back) inner.style.transform = 'rotateY(180deg)';
    return motion.finished.catch(() => {}).then(() => { director.anims.delete(motion); wrap.remove(); });
  }

  const unitScale = () => layout.s;
  const handPoint = el => ({ ...centerOf(el.getBoundingClientRect()), w: layout.handW * unitScale(), h: layout.handH * unitScale(), rot: el._angle || 0, tilt: 0 });
  const miniPoint = el => ({ ...centerOf(el.getBoundingClientRect()), w: layout.oppW * unitScale(), h: layout.oppH * unitScale(), rot: Number(el.dataset.rot) || 0, tilt: 0 });
  const deckPoint = () => ({ ...centerOf($('deck3d').getBoundingClientRect()), w: layout.deckW * unitScale(), h: layout.deckH * unitScale(), rot: -68, tilt: 54 });
  function pileSlot(card) {
    const seed = hashId(card.id);
    return { rot: Math.round(discardRot(card.id) * 1.7), dx: ((seed >> 5) % 29) - 14, dy: ((seed >> 9) % 21) - 10 };
  }
  function pilePoint(card) {
    const slot = pileSlot(card);
    const c = centerOf($('discardPile').getBoundingClientRect());
    return { x: c.x + slot.dx * unitScale(), y: c.y + slot.dy * unitScale() * 0.7, w: layout.pileW * unitScale(), h: layout.pileH * unitScale(), rot: slot.rot, tilt: 46 };
  }
  const pileFlightMs = who => (who === socket.id ? 680 : 780);

  function floatText(anchor, text, kind = '') {
    if (!anchor || FAST()) return;
    const rect = anchor.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = `float-text ${kind}`;
    el.textContent = text;
    el.style.left = `${rect.left + rect.width / 2}px`;
    el.style.top = `${rect.top + rect.height * 0.25}px`;
    $('cardFlightLayer').appendChild(el);
    window.setTimeout(() => el.remove(), 1700);
  }

  /* ------------------------------------------------------------------
     Choosing a card
  ------------------------------------------------------------------- */
  function onCardChosen(card, element) {
    if (!state?.game || state.game.winnerId || director.running) return;
    const me = state.players.find(player => player.id === socket.id);
    if (!me?.isTurn) { rejectCard(element); return flash('Wait for your turn'); }
    if (!localCanPlay(card, state.game, state.game.hand || [])) {
      rejectCard(element);
      return;
    }
    hoverIndex = -1; armedId = null;
    if (card.color === 'wild') {
      pendingWildCardId = card.id;
      pendingWildKind = card.value === 'Wild4' ? 'wild4' : 'wild';
      openWildWheel();
      playSfx('click');
      applyHandTransforms();
      return;
    }
    playSfx(['Draw2', 'Wild4', 'Skip', 'Reverse'].includes(card.value) ? 'action' : 'card');
    socket.emit('playCard', { cardId: card.id });
  }
  function openWildWheel() {
    const stage = $('wildPicker');
    stage.classList.remove('is-hidden', 'is-remote');
    stage.classList.toggle('is-wild4', pendingWildKind === 'wild4');
    stage.style.animation = 'none'; void stage.offsetWidth; stage.style.animation = '';
    socket.emit('wildPicking', { active: true, kind: pendingWildKind });
  }
  function closeWildWheel() {
    const stage = $('wildPicker');
    if (!stage || stage.classList.contains('is-hidden') || stage.classList.contains('is-remote')) return;
    stage.classList.add('is-hidden');
    socket.emit('wildPicking', { active: false });
  }
  function rejectCard(element) {
    if (element && !prefs.reduceMotion) {
      element.classList.remove('card-rejected');
      void element.offsetWidth;
      element.classList.add('card-rejected');
      window.setTimeout(() => element.classList.remove('card-rejected'), 380);
    }
    playSfx('error');
  }

  function renderLobby(next) {
    $('roomCodeDisplay').textContent = next.code || '------';
    const isHost = socket.id === next.hostId;
    const box = $('lobbyPlayers');
    box.replaceChildren();
    for (let index = 0; index < 5; index += 1) {
      const player = next.players[index];
      const slot = document.createElement('div');
      const avatar = document.createElement('span');
      const plate = document.createElement('span');
      plate.className = 'u-plate';
      if (!player) {
        slot.className = 'u-slot is-empty';
        avatar.className = 'u-avatar';
        avatar.textContent = '+';
        plate.textContent = '—';
      } else {
        slot.className = `u-slot${!player.connected ? ' is-offline' : ''}`;
        avatar.className = `u-avatar u-av-${index % 5}`;
        avatar.appendChild(makeAvatarSvg(index));
        if (player.id === next.hostId) {
          const crown = document.createElement('i');
          crown.className = 'u-crown';
          crown.textContent = '★';
          avatar.appendChild(crown);
        }
        plate.textContent = player.name;
      }
      slot.append(avatar, plate);
      box.appendChild(slot);
    }
    const canStart = isHost && next.players.length >= 2;
    $('startGame').classList.toggle('is-hidden', !isHost);
    $('startGame').disabled = !canStart;
    $('lobbyHint').textContent = !isHost ? 'Waiting for host…' : next.players.length < 2 ? 'Waiting for players…' : '';
    const settingsIds = {
      stacking: 'ruleStacking', zeroSeven: 'ruleZeroSeven',
      drawUntilPlayable: 'ruleDrawUntil', sixReaction: 'ruleSixReaction',
    };
    for (const [key, id] of Object.entries(settingsIds)) {
      $(id).checked = Boolean(next.settings[key]);
      $(id).disabled = !isHost || next.started;
    }
  }

  /* ------------------------------------------------------------------
     Opponents — persistent seats (DOM is reused, so cards MOVE instead of popping).
     One generic renderer: fan of face-down cards (+ mirrored reflection) and a panel.
  ------------------------------------------------------------------- */
  const seatEls = new Map();
  let curView = null;

  function fanLayout(count, cfg) {
    const { oppW, oppH, portrait } = layout;
    const shown = Math.min(count, 14);
    const cards = [];
    let boxW, boxH;
    if (cfg.kind === 'row') {
      const rowMax = cfg.max ?? (portrait ? 200 : 300);
      const step = shown > 1 ? Math.min(oppW * 0.52, rowMax / (shown - 1)) : 0;
      for (let i = 0; i < shown; i += 1) {
        const off = i - (shown - 1) / 2;
        cards.push({ x: off * step, y: off * off * 0.35, r: off * 1.1 });
      }
      boxW = step * Math.max(0, shown - 1) + oppW + 16; boxH = oppH + 10;
    } else {
      const a = (28 * Math.PI) / 180;
      const step = shown > 1 ? Math.min(oppW * 0.6, (portrait ? 150 : 215) / (shown - 1)) : 0;
      for (let i = 0; i < shown; i += 1) {
        const off = i - (shown - 1) / 2;
        cards.push({ x: off * step * Math.cos(a), y: off * step * Math.sin(a) * (cfg.side < 0 ? -1 : 1), r: (cfg.side < 0 ? 24 : -24) + off * 1.2 * (cfg.side < 0 ? 1 : -1) });
      }
      boxW = step * Math.cos(a) * Math.max(0, shown - 1) + oppW * 1.5; boxH = step * Math.sin(a) * Math.max(0, shown - 1) + oppH * 1.25;
    }
    return { cards, boxW, boxH };
  }

  function updateFan(fan, cards, hidden) {
    while (fan.children.length > cards.length) fan.lastElementChild.remove();
    while (fan.children.length < cards.length) {
      const back = makeCardBack();
      back.classList.add('mini-card');
      fan.appendChild(back);
    }
    cards.forEach((c, i) => {
      const el = fan.children[i];
      el.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) rotate(${c.r.toFixed(1)}deg)`;
      el.style.zIndex = String(i);
      el.dataset.rot = c.r.toFixed(1);
      el.classList.toggle('is-arriving', i >= cards.length - hidden);
    });
  }

  function ensureSeat(player) {
    let rec = seatEls.get(player.id);
    if (rec) return rec;
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.dataset.playerId = player.id;
    const wrap = document.createElement('div');
    wrap.className = 'seat-fan';
    const fan = document.createElement('div');
    fan.className = 'fan';
    const reflect = document.createElement('div');
    reflect.className = 'fan-reflect';
    reflect.setAttribute('aria-hidden', 'true');
    const reflectFan = document.createElement('div');
    reflectFan.className = 'fan';
    reflect.appendChild(reflectFan);
    wrap.append(fan, reflect);
    const panel = document.createElement('div');
    panel.className = 'seat-panel';
    const plate = document.createElement('span');
    plate.className = 'seat-plate';
    const avatar = document.createElement('span');
    avatar.className = 'seat-avatar';
    const count = document.createElement('b');
    count.className = 'seat-count';
    panel.append(plate, avatar, count);
    const swap = () => { if (curView?.game?.awaitingSwapPlayerId === socket.id && !director.running) socket.emit('swapHands', player.id); };
    panel.addEventListener('click', swap); wrap.addEventListener('click', swap);
    panel.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') swap(); });
    seat.append(wrap, panel);
    $('opponents').appendChild(seat);
    rec = { seat, wrap, fan, reflectFan, panel, plate, avatar, count, avatarIndex: -1, chip: null };
    seatEls.set(player.id, rec);
    return rec;
  }

  function renderOpponents(view) {
    const game = view.game;
    const meIndex = view.players.findIndex(player => player.id === socket.id);
    const total = view.players.length;
    const others = view.players
      .map((player, index) => ({ player, index, order: (index - meIndex + total) % total }))
      .filter(entry => entry.player.id !== socket.id)
      .sort((a, b) => a.order - b.order);
    const seatMaps = { 1: ['top'], 2: ['left', 'right'], 3: ['left', 'top', 'right'], 4: ['left', 'tl', 'tr', 'right'] };
    const seats = seatMaps[others.length] || seatMaps[4];
    const cfgSet = layout.portrait ? SEAT_CFG.portrait : SEAT_CFG.landscape;
    $('stage').classList.toggle('seats-4', others.length === 4);
    const keep = new Set(others.map(entry => entry.player.id));
    for (const [id, rec] of seatEls) if (!keep.has(id)) { rec.seat.remove(); seatEls.delete(id); }
    const challenge = !view.anim && game?.unoChallenge && Date.now() <= game.unoChallenge.deadline ? game.unoChallenge : null;
    const safe = !view.anim && game?.sixReaction?.active ? game.sixReaction.pressed : [];
    others.forEach(({ player, index }, order) => {
      const cfg = cfgSet[seats[order]] || cfgSet.top;
      const rec = ensureSeat(player);
      const hidden = view.hiddenCards?.[player.id] || 0;
      const { cards, boxW, boxH } = fanLayout(player.count, cfg);
      rec.wrap.style.cssText = `left:${cfg.hand[0]}%;top:${cfg.hand[1]}%;width:${boxW}px;height:${boxH}px;`;
      rec.wrap.style.transform = `translate(-50%, -50%)${cfg.kind === 'diag' ? ` perspective(900px) rotateY(${cfg.side < 0 ? 36 : -36}deg)` : ''}`;
      updateFan(rec.fan, cards, hidden);
      updateFan(rec.reflectFan, cards, hidden);
      rec.panel.style.left = `${cfg.panel[0]}%`; rec.panel.style.top = `${cfg.panel[1]}%`;
      rec.panel.className = `seat-panel acc-${index % 5}${player.isTurn && !game.winnerId ? ' is-active' : ''}${!player.connected ? ' is-offline' : ''}${safe.includes(player.id) ? ' is-safe' : ''}`;
      if (rec.avatarIndex !== index) { rec.avatarIndex = index; rec.avatar.replaceChildren(makeAvatarSvg(index)); }
      rec.plate.textContent = player.name;
      rec.count.textContent = String(Math.max(0, player.count - hidden));
      const swapMode = !view.anim && game?.awaitingSwapPlayerId === socket.id;
      rec.panel.classList.toggle('swap-target', swapMode);
      rec.wrap.classList.toggle('swap-target', swapMode);
      rec.panel.style.pointerEvents = swapMode ? 'auto' : '';
      rec.wrap.style.pointerEvents = swapMode ? 'auto' : '';
      if (swapMode) { rec.panel.tabIndex = 0; rec.panel.setAttribute('role', 'button'); rec.panel.setAttribute('aria-label', `Swap hands with ${player.name}`); }
      if (challenge && challenge.targetId === player.id) {
        if (!rec.chip) {
          rec.chip = document.createElement('button');
          rec.chip.type = 'button';
          rec.chip.className = 'catch-chip';
          rec.chip.textContent = 'CATCH!';
          rec.chip.addEventListener('click', () => { socket.emit('catchUno', player.id); playSfx('action'); rec.chip?.remove(); rec.chip = null; });
          rec.panel.appendChild(rec.chip);
        }
      } else if (rec.chip) { rec.chip.remove(); rec.chip = null; }
    });
    if (unoChallengeTicker) { clearTimeout(unoChallengeTicker); unoChallengeTicker = null; }
    if (challenge) {
      unoChallengeTicker = window.setTimeout(() => { for (const rec of seatEls.values()) { rec.chip?.remove(); rec.chip = null; } }, Math.max(0, challenge.deadline - Date.now() + 15));
    }
  }

  function seatBubble(playerId, text, kind = '') {
    const panel = playerId === socket.id ? $('youSeat') : seatEls.get(playerId)?.panel;
    if (!panel) return;
    const bubble = document.createElement('span');
    bubble.className = `seat-bubble ${kind}`;
    bubble.textContent = text;
    panel.appendChild(bubble);
    window.setTimeout(() => bubble.remove(), 1600);
  }

  /* ------------------------------------------------------------------
     Your hand. Hover is resolved from the *layout* (never from transformed boxes) so
     lifting / spreading a card can never change which card is under the cursor.
  ------------------------------------------------------------------- */
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const VALUE_ORDER = { Skip: 10, Reverse: 11, Draw2: 12, Wild: 20, Wild4: 21 };
  const HAND_CENTER = 0.52;
  function sortHand(hand) {
    const rank = card => (COLOR_ORDER[card.color] ?? 5) * 100 + (VALUE_ORDER[card.value] ?? (Number(card.value) || 0));
    return [...hand].sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
  }
  function handMetrics(count) {
    const { w, handW, portrait } = layout;
    const avail = portrait ? w * 0.9 : Math.min(w * 0.5, 700);
    const step = count > 1 ? Math.min(handW * 0.56, (avail - handW) / (count - 1)) : 0;
    const total = step * Math.max(0, count - 1) + handW;
    return { step, total, left: -total / 2 };
  }
  function hitTestHand(event) {
    const count = handView.cards.length;
    if (!count || !layout) return -1;
    const rect = $('myHand').getBoundingClientRect();
    const { handH, pad, s } = layout;
    const lift = handH * 0.22;
    const baseTop = rect.bottom - (pad + handH) * s;
    if (event.clientY < baseTop - lift * 0.75 * s || event.clientY > rect.bottom) return -1;
    const { step, total, left } = handMetrics(count);
    const relX = (event.clientX - (rect.left + rect.width * HAND_CENTER)) / s;
    if (relX < left || relX > left + total) return -1;
    if (step <= 0) return 0;
    return clampNum(0, Math.floor((relX - left) / step), count - 1);
  }
  function setHover(index) {
    if (index === hoverIndex) return;
    hoverIndex = index;
    applyHandTransforms();
  }
  function applyHandTransforms() {
    const els = handView.els;
    const count = els.length;
    if (!count || !layout) return;
    const { handW, handH } = layout;
    const { step } = handMetrics(count);
    const lift = handH * 0.22;
    const arcK = 2.0 - Math.min(count, 14) * 0.07;
    const angStep = count > 1 ? Math.min(3, 36 / (count - 1)) : 0;
    const spread = clampNum(handW * 0.12, handW * 0.8 - step, handW * 0.42);
    const falloff = [0, 1, 0.6, 0.3, 0.12, 0.05];
    els.forEach((el, i) => {
      const off = i - (count - 1) / 2;
      let x = off * step, y = off * off * arcK, angle = off * angStep, scale = 1;
      if (el._playable) y -= 12;
      if (hoverIndex >= 0 && !el.classList.contains('is-arriving')) {
        if (i === hoverIndex) { y = -lift; angle = 0; scale = 1.1; }
        else { const d = i - hoverIndex; x += Math.sign(d) * spread * (falloff[Math.min(Math.abs(d), 5)] || 0); }
      }
      el._angle = angle;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${angle.toFixed(2)}deg) scale(${scale})`;
      el.style.zIndex = String(i === hoverIndex ? 1000 : i + 1);
      el.classList.toggle('is-hovered', i === hoverIndex);
      el.dataset.slot = String(i);
    });
  }

  function renderHand(view) {
    const game = view.game;
    const hand = sortHand(game.hand || []);
    const container = $('myHand');
    const me = view.players.find(player => player.id === socket.id);
    const meIndex = Math.max(0, view.players.findIndex(player => player.id === socket.id));
    const isMyTurn = Boolean(me?.isTurn && !game.winnerId && !view.anim);
    const hiddenIds = view.hiddenHandIds || new Set();
    const oldElements = new Map([...container.querySelectorAll('[data-card-id]')].map(el => [el.dataset.cardId, el]));
    const newIds = new Set(hand.map(card => card.id));
    for (const [id, element] of oldElements) if (!newIds.has(id)) element.remove();
    const els = [];
    hand.forEach(card => {
      let element = oldElements.get(card.id);
      if (!element) {
        element = createCardElement(card, { interactive: true });
        element.tabIndex = -1;
        container.appendChild(element);
      }
      const playable = isMyTurn && localCanPlay(card, game, hand);
      element._playable = playable;
      element.classList.toggle('is-unplayable', isMyTurn && !playable);
      element.classList.toggle('is-arriving', hiddenIds.has(card.id));
      els.push(element);
    });
    handView = { cards: hand, els };
    if (hoverIndex >= hand.length) hoverIndex = hand.length - 1;
    if (!isMyTurn && armedId) armedId = null;
    applyHandTransforms();

    const youPanel = $('youSeat');
    $('myHandCount').textContent = String(Math.max(0, hand.length - hiddenIds.size));
    $('myNameLabel').textContent = me?.name || 'YOU';
    if (youPanel.dataset.avatar !== String(meIndex)) {
      youPanel.dataset.avatar = String(meIndex);
      $('myAvatar').replaceChildren(makeAvatarSvg(meIndex));
      youPanel.className = `seat-panel me acc-${meIndex % 5}`;
    }
    youPanel.classList.toggle('is-active', Boolean(me?.isTurn && !game.winnerId));
    youPanel.classList.toggle('is-safe', !view.anim && Boolean(game.sixReaction?.active && game.sixReaction.pressed.includes(socket.id)));

    const playableCount = hand.filter(card => localCanPlay(card, game, hand)).length;
    const calm = view.anim;
    const canCallUno = !calm && isMyTurn && hand.length === 2 && playableCount > 0 && game.pendingDraw === 0 && !game.pendingWild4 && !game.drawnPlayableCardId;
    const uno = $('unoButton');
    uno.classList.toggle('is-hidden', !canCallUno);
    uno.disabled = Boolean(game.armedUno);
    uno.classList.toggle('is-called', Boolean(game.armedUno));

    const drawButton = $('drawPile');
    drawButton.disabled = calm || !isMyTurn || Boolean(game.winnerId) || Boolean(game.awaitingSwapPlayerId) || Boolean(game.sixReaction?.active) || Boolean(game.drawnPlayableCardId);
    document.querySelector('.pile-draw').classList.toggle('draw-ready', !calm && isMyTurn && !playableCount && !game.pendingWild4 && !game.drawnPlayableCardId && !game.pendingDraw);
    const badge = $('drawBadge');
    badge.classList.toggle('is-hidden', calm || !(game.pendingDraw > 0));
    if (game.pendingDraw > 0) badge.textContent = `+${game.pendingDraw}`;

    const wildTarget = Boolean(!calm && isMyTurn && game.pendingWild4?.targetId === socket.id);
    $('passTurn').classList.toggle('is-hidden', calm || !(isMyTurn && game.drawnPlayableCardId));
    $('takePenalty').classList.toggle('is-hidden', calm || !(isMyTurn && game.pendingDraw > 0 && !game.pendingWild4));
    $('takePenalty').textContent = `Take ${game.pendingDraw}`;
    $('challengeWildFour').classList.toggle('is-hidden', !wildTarget);
    $('acceptWildFour').classList.toggle('is-hidden', !wildTarget);
  }

  function renderStatus(view) {
    if (Date.now() < statusOverrideUntil) return;
    const game = view.game;
    const el = $('tableMessage');
    el.textContent = !view.anim && !game.winnerId && game.awaitingSwapPlayerId === socket.id ? 'Pick a player to swap with' : '';
    el.className = 'status-line';
  }

  /* ------------------------------------------------------------------
     6 Reaction — a big electric-blue, pulsing button with a draining countdown ring.
     Last one to tap (or anyone who never taps) draws 2.
  ------------------------------------------------------------------- */
  let reactionTimer = null;
  function renderReaction(game) {
    const six = $('reactionOverlay');
    const reaction = game?.sixReaction;
    clearTimeout(reactionTimer);
    if (!reaction?.active) { six.classList.add('is-hidden'); six.dataset.rid = ''; return; }
    const now = srvNow();
    const go = now >= reaction.startsAt;
    const safe = reaction.pressed.includes(socket.id);
    six.classList.remove('is-hidden');
    if (six.dataset.rid !== reaction.id) {
      six.dataset.rid = reaction.id;
      six.classList.remove('is-appear');
      void six.offsetWidth;
      six.classList.add('is-appear');
      window.setTimeout(() => six.classList.remove('is-appear'), 700);
      const ring = $('sixRing');
      ring.style.animation = 'none';
      void ring.getBoundingClientRect();
      if (!go) ring.style.animation = `six-charge ${Math.max(150, reaction.startsAt - now)}ms linear forwards`;
    }
    six.disabled = !go || safe;
    six.classList.toggle('is-lock', !go);
    six.classList.toggle('is-go', go && !safe);
    six.classList.toggle('is-safe', safe);
    $('sixLabel').textContent = safe ? '✓' : '6';
    if (go && six.dataset.go !== reaction.id) {
      six.dataset.go = reaction.id;
      playSfx('reaction');
      six.classList.add('is-flash');
      window.setTimeout(() => six.classList.remove('is-flash'), 650);
    }
    if (!go) reactionTimer = window.setTimeout(() => { if (curView?.game) renderReaction(curView.game); }, reaction.startsAt - now + 20);
  }

  /* ------------------------------------------------------------------
     Effects that punctuate special cards (burst, ring, big icon, sparks)
  ------------------------------------------------------------------- */
  const BURST_COLORS = { red: '#ff4b3a', yellow: '#ffd51f', green: '#34e06a', blue: '#2fa8ff', wild: '#ffffff' };
  const BURST_ICONS = {
    Reverse: '<svg viewBox="0 0 100 100"><path d="M18 46 A32 32 0 0 1 72 24 L64 14 L90 22 L80 48 L74 38 A40 40 0 0 0 26 54Z M82 54 A32 32 0 0 1 28 76 L36 86 L10 78 L20 52 L26 62 A40 40 0 0 0 74 46Z" /></svg>',
    Skip: '<svg viewBox="0 0 100 100"><path d="M50 8 A42 42 0 1 0 50 92 A42 42 0 1 0 50 8Z M50 24 A26 26 0 0 1 70 32 L32 70 A26 26 0 0 1 50 24Z M76 40 A26 26 0 0 1 50 76 A26 26 0 0 1 42 74Z" fill-rule="evenodd"/></svg>',
    Draw2: '<svg viewBox="0 0 100 100"><rect x="14" y="26" width="42" height="60" rx="7" transform="rotate(-12 35 56)"/><rect x="42" y="18" width="42" height="60" rx="7" transform="rotate(10 63 48)"/></svg>',
    Wild4: '<svg viewBox="0 0 100 100"><rect x="14" y="20" width="36" height="52" rx="6" transform="rotate(-14 32 46)"/><rect x="34" y="14" width="36" height="52" rx="6"/><rect x="52" y="24" width="36" height="52" rx="6" transform="rotate(14 70 50)"/></svg>',
    Wild: '<svg viewBox="0 0 100 100"><path d="M50 50 L50 6 A44 44 0 0 1 94 50Z"/><path d="M50 50 L94 50 A44 44 0 0 1 50 94Z"/><path d="M50 50 L50 94 A44 44 0 0 1 6 50Z"/><path d="M50 50 L6 50 A44 44 0 0 1 50 6Z"/></svg>',
  };
  async function playEffect(card, colorKey) {
    if (FAST() || card.color === 'wild') return;
    const kind = BURST_ICONS[card.value] ? card.value : 'num';
    const host = document.querySelector('.center');
    const el = document.createElement('div');
    el.className = `burst burst-${kind}`;
    el.style.setProperty('--bc', BURST_COLORS[card.color === 'wild' ? colorKey : card.color] || '#fff');
    el.innerHTML = `<i class="burst-flash"></i><i class="burst-ring"></i><i class="burst-ring r2"></i>${kind === 'num' ? '' : `<span class="burst-icon">${BURST_ICONS[kind]}${kind === 'Draw2' ? '<b>+2</b>' : kind === 'Wild4' ? '<b>+4</b>' : ''}</span>`}`
      + Array.from({ length: kind === 'num' ? 6 : 12 }, (_, i) => `<u class="burst-spark" style="--a:${Math.round((360 / (kind === 'num' ? 6 : 12)) * i + Math.random() * 20)}deg;--d:${70 + Math.round(Math.random() * 90)}px"></u>`).join('');
    host.appendChild(el);
    window.setTimeout(() => el.remove(), 1250);
    if (kind !== 'num') playSfx('action');
    await sleep(kind === 'num' ? 120 : 760);
  }

  /* ------------------------------------------------------------------
     Pure rendering of a "view" (a server state, possibly rewound by the director so that
     a transition can be shown one beat at a time).
  ------------------------------------------------------------------- */
  const cloneView = next => ({ ...next, players: next.players.map(p => ({ ...p })), game: { ...next.game, hand: [...(next.game.hand || [])] }, anim: false, hiddenCards: {}, hiddenHandIds: new Set() });

  function resetSceneForRound(roundId) {
    discardRound = roundId;
    discardStack = []; lastTopId = null; lastGameSnapshot = null;
    hoverIndex = -1; armedId = null; handView = { cards: [], els: [] };
    $('myHand').replaceChildren();
    for (const rec of seatEls.values()) rec.seat.remove();
    seatEls.clear();
  }

  function renderView(view) {
    const game = view.game;
    curView = view;
    layoutField();
    if (discardRound !== game.roundId) resetSceneForRound(game.roundId);
    $('gameRoomCode').textContent = view.code;
    renderOpponents(view);
    renderHand(view);
    $('field').style.setProperty('--cur', COLOR_HEX[game.color] || COLOR_HEX.red);
    $('dirRing').style.setProperty('--dir', game.direction === -1 ? '-1' : '1');
    $('deckCount').textContent = String(game.drawCount);

    const top = game.top;
    let isNewTop = false;
    if (top && top.id !== lastTopId) {
      const slot = pileSlot(top);
      discardStack.push({ card: top, ...slot, wildColor: top.color === 'wild' && !view.anim ? game.color : null });
      if (discardStack.length > 7) discardStack.shift();
      lastTopId = top.id;
      isNewTop = true;
    }
    const pile = $('discardPile');
    pile.replaceChildren();
    discardStack.forEach((entry, index) => {
      const wrap = document.createElement('div');
      const isTop = index === discardStack.length - 1;
      wrap.className = `discard-card${isTop ? ' is-top' : ''}`;
      wrap.style.transform = `translate(${entry.dx}px, ${entry.dy}px) rotate(${entry.rot}deg)`;
      const cardEl = createCardElement(entry.card, { wildColor: entry.wildColor });
      if (!isTop) cardEl.style.filter = `brightness(${(0.72 + 0.28 * (index / Math.max(1, discardStack.length - 1))).toFixed(2)})`;
      wrap.appendChild(cardEl);
      if (isTop && isNewTop && lastGameSnapshot && !FAST()) wrap.classList.add('is-new');
      pile.appendChild(wrap);
    });
    $('discardPile').closest('.pile-discard').classList.toggle('is-empty', !top);

    renderStatus(view);
    if (view.anim) { renderReaction(null); lastGameSnapshot = lastGameSnapshot || {}; return; }
    renderReaction(game);

    if (game.lastSixResult && game.lastSixResult.id !== lastSixShown) {
      lastSixShown = game.lastSixResult.id;
      if (lastGameSnapshot) game.lastSixResult.loserIds.forEach(id => seatBubble(id, game.lastSixResult.reason === 'last' ? 'SLOWEST!' : 'TOO SLOW!', 'is-bad'));
    }
    if (game.unoAnnouncement && game.unoAnnouncement.id !== lastUnoAnimationId) {
      lastUnoAnimationId = game.unoAnnouncement.id;
      showUnoFx(game.unoAnnouncement.playerId);
      playSfx('uno');
    }
    if (game.winnerId && lastWinnerShown !== `${game.roundId}:${game.winnerId}`) {
      lastWinnerShown = `${game.roundId}:${game.winnerId}`;
      window.setTimeout(() => showWinner(game.winnerId === socket.id, game.winnerName), FAST() ? 0 : 900);
    }
    if (lastGameSnapshot && (game.lastCardId !== lastGameSnapshot.lastCardId || game.turn !== lastGameSnapshot.turn)) {
      const stage = $('wildPicker');
      if (stage.classList.contains('is-remote')) { stage.classList.add('is-hidden'); stage.classList.remove('is-remote'); }
    }
    lastGameSnapshot = { lastCardId: game.lastCardId, lastAction: game.lastAction, turn: game.turn };
  }

  /* ------------------------------------------------------------------
     The director: turns every server state change into an ordered, slow-paced scene
       play → impact effect → each drawn card (deck → hand, flipping face-up) → new turn.
     Inputs are locked while it runs; a click anywhere skips to the end.
  ------------------------------------------------------------------- */
  let lastSixShown = null;

  // A card leaves a source (the deck by default), flies to its (hidden) slot and is revealed exactly where it lands.
  function dispatchDraw(view, next, playerId, card, { duration = 720, spin = 0, flipUp = true, from = null } = {}) {
    const isMe = playerId === socket.id;
    let target;
    if (isMe) {
      view.game.hand = [...view.game.hand, card];
      view.hiddenHandIds.add(card.id);
      renderView(view);
      const idx = handView.cards.findIndex(c => c.id === card.id);
      target = handView.els[idx] ? handPoint(handView.els[idx]) : null;
    } else {
      view.hiddenCards[playerId] = (view.hiddenCards[playerId] || 0) + 1;
      const p = view.players.find(q => q.id === playerId);
      if (p) p.count += 1;
      renderView(view);
      const last = seatEls.get(playerId)?.fan.lastElementChild;
      target = last ? miniPoint(last) : null;
    }
    playSfx('draw');
    return flyCard({ card: isMe ? card : null, back: true, flip: isMe && flipUp ? 'toFront' : null, from: from || deckPoint(), to: target, duration, arc: -90, spin }).then(() => {
      if (isMe) view.hiddenHandIds.delete(card.id);
      else view.hiddenCards[playerId] = Math.max(0, (view.hiddenCards[playerId] || 1) - 1);
      renderView(view);
    });
  }

  function diffEvents(prev, next) {
    const pg = prev.game, ng = next.game;
    const play = ng.lastCardId && ng.lastCardId !== pg.lastCardId && ng.top ? { playerId: ng.lastPlayerId, card: ng.top } : null;
    // 7 → two players trade hands; 0 → every hand moves one seat in the direction of play.
    let moves = null;
    if (ng.lastSwap && ng.lastSwap.id !== pg.lastSwap?.id) moves = [{ from: ng.lastSwap.a, to: ng.lastSwap.b }, { from: ng.lastSwap.b, to: ng.lastSwap.a }];
    else if (ng.lastRotate && ng.lastRotate.id !== pg.lastRotate?.id) {
      const ids = next.players.map(p => p.id);
      moves = ids.map((id, i) => ({ from: id, to: ids[(i + ng.lastRotate.direction + ids.length) % ids.length] }));
    }
    const penalty = Boolean((play && ['Draw2', 'Wild4'].includes(String(play.card.value))) || pg.pendingDraw > 0 || pg.pendingWild4);
    const draws = [];
    if (!moves) {
      const prevIds = new Set((pg.hand || []).map(c => c.id));
      for (const p of next.players) {
        const before = prev.players.find(q => q.id === p.id);
        if (!before) continue;
        const played = play && play.playerId === p.id ? 1 : 0;
        const n = p.count - (before.count - played);
        if (n <= 0) continue;
        const cards = p.id === socket.id ? (ng.hand || []).filter(c => !prevIds.has(c.id)) : null;
        draws.push({ playerId: p.id, n: cards ? cards.length : n, cards, penalty });
      }
    }
    return { play, draws, moves };
  }

  const seatStackPoint = playerId => {
    if (playerId === socket.id) {
      const r = $('myHand').getBoundingClientRect();
      return { x: r.left + r.width * HAND_CENTER, y: r.bottom - (layout.pad + layout.handH * 0.5) * layout.s, w: layout.handW * layout.s * 0.8, h: layout.handH * layout.s * 0.8, rot: 0, tilt: 0 };
    }
    const rec = seatEls.get(playerId);
    return { ...centerOf(rec.wrap.getBoundingClientRect()), w: layout.oppW * layout.s, h: layout.oppH * layout.s, rot: 0, tilt: 0 };
  };

  // OG-style trade: every hand is gathered into a stack, stacks glide to their new owners, then spread into a fan.
  async function handoverScene(view, next, moves, chk) {
    const stackPts = new Map(moves.map(m => [m.from, seatStackPoint(m.from)]));
    const gather = [];
    for (const m of moves) {
      const pt = stackPts.get(m.from);
      if (m.from === socket.id) {
        handView.els.forEach((el, i) => gather.push(flyCard({ card: handView.cards[i], flip: 'toBack', from: handPoint(el), to: pt, duration: 520, delay: i * 30, arc: -24 })));
        view.game.hand = [];
      } else {
        [...(seatEls.get(m.from)?.fan.children || [])].forEach((el, i) => gather.push(flyCard({ back: true, from: miniPoint(el), to: pt, duration: 520, delay: i * 30, arc: -18 })));
        const p = view.players.find(q => q.id === m.from);
        if (p) p.count = 0;
      }
    }
    playSfx('card');
    renderView(view);
    await Promise.all(gather); chk();
    await sleep(140); chk();
    const travel = [];
    moves.forEach((m, k) => {
      const from = stackPts.get(m.from), to = stackPts.get(m.to);
      for (let layer = 0; layer < 4; layer += 1) {
        travel.push(flyCard({ back: true, from: { ...from, x: from.x + layer * 1.6, y: from.y - layer * 2.4 }, to: { ...to, x: to.x + layer * 1.6, y: to.y - layer * 2.4 }, duration: 950, delay: layer * 30, arc: k % 2 ? 80 : -100, spin: k % 2 ? -12 : 10 }));
      }
    });
    playSfx('action');
    await Promise.all(travel); chk();
    await sleep(100); chk();
    const spreads = moves.map(m => (async () => {
      const dest = next.players.find(q => q.id === m.to);
      const list = m.to === socket.id ? [...(next.game.hand || [])] : Array.from({ length: dest?.count || 0 }, (_, i) => ({ id: `spread-${m.to}-${i}` }));
      const flights = [];
      for (const card of list) { flights.push(dispatchDraw(view, next, m.to, card, { from: stackPts.get(m.to), duration: 640 })); await sleep(55); chk(); }
      await Promise.all(flights);
    })());
    await Promise.all(spreads); chk();
  }

  // Wild card: it lands as its black face; once a colour is chosen the matching sprite fades in with a soft light sweep.
  async function recolorTop(color, view) {
    const entry = discardStack[discardStack.length - 1];
    const cardEl = document.querySelector('#discardPile .discard-card.is-top .playing-card');
    if (entry && cardEl && !FAST()) {
      const img = document.createElement('img');
      img.className = 'recolor-img';
      img.src = `/cards/${cardFile(entry.card, color)}`;
      img.alt = ''; img.draggable = false;
      const glow = document.createElement('i');
      glow.className = 'recolor-glow';
      cardEl.append(img, glow);
      playSfx('action');
      await sleep(760);
    }
    if (entry) entry.wildColor = color;
    view.game.color = color;
    renderView(view);
  }

  async function playEvents(prev, next, ev, chk) {
    const pg = prev.game, ng = next.game;
    const view = cloneView(next);
    view.anim = true;
    view.game.top = pg.top; view.game.color = pg.color; view.game.direction = pg.direction;
    view.game.hand = [...(pg.hand || [])];
    view.players.forEach(p => { const before = prev.players.find(q => q.id === p.id); if (before) { p.count = before.count; p.isTurn = before.isTurn; } });
    renderView(view);

    if (ev.play) {
      const { playerId, card } = ev.play;
      const me = playerId === socket.id;
      const isWild = card.color === 'wild';
      if (isWild) { const stage = $('wildPicker'); stage.classList.add('is-hidden'); stage.classList.remove('is-remote'); }
      let from = null;
      if (me) {
        const el = handView.els[handView.cards.findIndex(c => c.id === card.id)];
        if (el) from = handPoint(el);
        view.game.hand = view.game.hand.filter(c => c.id !== card.id);
      } else {
        const last = seatEls.get(playerId)?.fan.lastElementChild;
        if (last) from = miniPoint(last);
        const p = view.players.find(q => q.id === playerId);
        if (p) p.count = Math.max(0, p.count - 1);
      }
      renderView(view);
      playSfx(['Draw2', 'Wild4', 'Skip', 'Reverse'].includes(card.value) ? 'action' : 'card');
      await flyCard({ card, back: !me, flip: me ? null : 'toFront', from, to: pilePoint(card), duration: pileFlightMs(playerId), arc: me ? -90 : -70 });
      chk();
      view.game.top = ng.top; view.game.direction = ng.direction;
      if (!isWild) view.game.color = ng.color;
      renderView(view);
      if (isWild) { await sleep(420); chk(); await recolorTop(ng.color, view); }
      else await playEffect(card, ng.color);
      chk();
    } else {
      view.game.color = ng.color; view.game.direction = ng.direction; view.game.top = ng.top;
    }

    if (ev.moves) {
      await sleep(250); chk();
      await handoverScene(view, next, ev.moves, chk);
    }

    for (const d of ev.draws) {
      const anchor = d.playerId === socket.id ? $('youSeat') : seatEls.get(d.playerId)?.wrap;
      if (d.penalty && d.n >= 2) floatText(anchor, `+${d.n}`, 'is-draw');
      const list = d.cards || Array.from({ length: d.n }, (_, i) => ({ id: `ghost-${d.playerId}-${i}` }));
      if (d.playerId === socket.id) view.game.hand = view.game.hand.filter(c => !list.some(x => x.id === c.id));
      const flights = [];
      for (const card of list) {
        flights.push(dispatchDraw(view, next, d.playerId, card));
        await sleep(430);
        chk();
      }
      await Promise.all(flights);
      chk();
    }
    await sleep(260);
  }

  async function dealSequence(next, chk) {
    const ng = next.game;
    const view = cloneView(next);
    view.anim = true;
    view.game.top = null; view.game.hand = [];
    view.players.forEach(p => { p.count = 0; p.isTurn = false; });
    const deck = document.querySelector('.pile-draw');
    deck.classList.add('deck-center');
    renderView(view);
    await sleep(1000); chk();
    const flights = [];
    const mine = [...(ng.hand || [])];
    const perPlayer = mine.length || 7;
    for (let round = 0; round < perPlayer; round += 1) {
      for (const p of next.players) {
        const card = p.id === socket.id ? mine[round] : { id: `deal-${p.id}-${round}` };
        flights.push(dispatchDraw(view, next, p.id, card, { duration: 680, spin: p.id === socket.id ? 0 : 160 }));
        await sleep(90);
        chk();
      }
    }
    await Promise.all(flights); chk();
    await sleep(250);
    if (ng.top) {
      playSfx('card');
      await flyCard({ card: ng.top, back: true, flip: 'toFront', from: deckPoint(), to: pilePoint(ng.top), duration: 820, arc: -60 });
      chk();
      view.game.top = ng.top; view.game.color = ng.color; view.game.direction = ng.direction;
      renderView(view);
    }
    deck.classList.remove('deck-center');
    await sleep(900);
  }

  async function transition(prev, next, backlog, gen) {
    const chk = () => { if (gen !== director.gen) throw ABORT; };
    const ng = next.game;
    if (!prev || prev.game.roundId !== ng.roundId) {
      resetSceneForRound(ng.roundId);
      if (!ng.lastCardId && !FAST() && backlog < 2) await dealSequence(next, chk);
      return;
    }
    if (FAST() || backlog >= 3) return;
    const ev = diffEvents(prev, next);
    if (!ev.play && !ev.draws.length && !ev.moves) return;
    await playEvents(prev, next, ev, chk);
  }

  async function pump() {
    if (director.running) return;
    director.running = true;
    const gen = director.gen;
    try {
      while (director.queue.length && gen === director.gen) {
        const next = director.queue.shift();
        try { await transition(director.shown, next, director.queue.length, gen); }
        catch (error) { if (error !== ABORT) console.error(error); }
        if (gen !== director.gen) break;
        renderView(cloneView(next));
        director.shown = next;
      }
    } finally {
      if (gen === director.gen) { director.running = false; director.skip = false; }
    }
  }
  window.__unoDirector = director; // read-only handle for debugging / automated tests
  director.enqueue = next => { director.queue.push(next); pump(); };
  director.reset = () => {
    director.gen += 1; director.queue = []; director.running = false; director.skip = false; director.shown = null;
    director.anims.forEach(a => { try { a.cancel(); } catch { /* ignore */ } });
    director.anims.clear();
    $('cardFlightLayer').replaceChildren();
    document.querySelector('.pile-draw')?.classList.remove('deck-center');
  };
  director.fastForward = () => {
    if (!director.running) return;
    director.skip = true;
    director.anims.forEach(a => { try { a.finish(); } catch { /* ignore */ } });
  };

  // 3D "UNO!" lying on the table in front of the caller, upright from THEIR point of view
  // (everyone sees the same thing, so it is upside-down/sideways for people seated elsewhere).
  function showUnoFx(callerId) {
    const layer = $('unoFx');
    if (!layer || !layout) return;
    const target = centerOf($('discardPile').getBoundingClientRect());
    let from;
    if (callerId === socket.id) {
      const hand = $('myHand').getBoundingClientRect();
      from = { x: hand.left + hand.width * HAND_CENTER, y: hand.bottom - layout.handH * layout.s * 0.6 };
    } else {
      const avatar = seatEls.get(callerId)?.avatar;
      if (!avatar) return;
      from = centerOf(avatar.getBoundingClientRect());
    }
    const spot = { x: from.x + (target.x - from.x) * 0.55, y: from.y + (target.y - from.y) * 0.55 };
    const rz = Math.round(Math.atan2(target.x - from.x, -(target.y - from.y)) * 180 / Math.PI);
    const fx = document.createElement('div');
    fx.className = 'uno-fx';
    fx.style.left = `${spot.x}px`; fx.style.top = `${spot.y}px`; fx.style.setProperty('--rz', `${rz}deg`);
    const word = document.createElement('div');
    word.className = 'uno-fx-word';
    ['U', 'N', 'O', '!'].forEach((ch, i) => { const s = document.createElement('span'); s.textContent = ch; s.style.setProperty('--i', String(i)); word.appendChild(s); });
    fx.appendChild(word);
    if (!prefs.reduceMotion) {
      const colors = ['#ee2a3b', '#ffd51f', '#25b25e', '#2a86dc', '#ffffff'];
      for (let i = 0; i < 18; i += 1) {
        const star = document.createElement('i');
        const angle = Math.random() * Math.PI * 2, dist = 140 + Math.random() * 230;
        star.className = 'uno-fx-star';
        star.style.setProperty('--tx', `${Math.cos(angle) * dist * 1.25}px`);
        star.style.setProperty('--ty', `${Math.sin(angle) * dist * 0.8}px`);
        star.style.setProperty('--tz', `${60 + Math.random() * 220}px`);
        star.style.setProperty('--s', `${34 + Math.random() * 38}px`);
        star.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
        star.style.setProperty('--d', `${0.05 + Math.random() * 0.3}s`);
        star.style.setProperty('--c', colors[i % colors.length]);
        fx.appendChild(star);
      }
    }
    layer.appendChild(fx);
    window.setTimeout(() => fx.remove(), 2400);
  }

  function showWinner(isMe, name) {
    $('winnerTitle').textContent = isMe ? 'UNO! YOU WIN!' : `${name || 'A RIVAL'} WINS!`;
    $('winnerDescription').textContent = isMe ? 'Beautifully played. Ready for the rematch?' : 'The table remembers. Shuffle up for a rematch.';
    $('winOverlay').classList.remove('is-hidden');
    playSfx('win');
  }

  function applyState(next) {
    syncClock(next.serverNow);
    const wasStarted = Boolean(state?.started);
    state = next;
    roomCode = next.code || roomCode;
    if (next.started && next.game) {
      closeModal('roomSetupModal');
      showScreen('gameScreen');
      director.enqueue(next);
      clearTimeout(sixGoTimer);
      const six = next.game.sixReaction;
      // At the GO moment everyone's tap window opens together: finish any animation still running so the button is live.
      if (six?.active) sixGoTimer = window.setTimeout(() => director.fastForward(), Math.max(0, six.startsAt - srvNow()) + 40);
    } else {
      director.reset();
      curView = null;
      for (const rec of seatEls.values()) rec.seat.remove();
      seatEls.clear();
      $('winOverlay').classList.add('is-hidden');
      lastWinnerShown = null;
      lastGameSnapshot = null;
      discardStack = []; lastTopId = null; discardRound = null; prevCounts = new Map(); hoverIndex = -1; armedId = null; handView = { cards: [], els: [] };
      $('myHand')?.replaceChildren();
      renderLobby(next);
      showScreen('lobbyScreen');
      if (wasStarted) playSfx('click');
    }
  }

  function updateHouseRules() {
    if (!state || state.hostId !== socket.id || state.started) return;
    socket.emit('updateSettings', {
      stacking: $('ruleStacking').checked,
      zeroSeven: $('ruleZeroSeven').checked,
      drawUntilPlayable: $('ruleDrawUntil').checked,
      sixReaction: $('ruleSixReaction').checked,
    });
  }
  function openRoomSetup(mode) {
    setupMode = mode;
    $('setupTitle').textContent = mode === 'create' ? 'New room' : 'Join room';
    $('setupEyebrow').textContent = mode === 'create' ? 'MAKE IT A PRIVATE TABLE' : 'YOU HAVE AN INVITATION';
    $('setupDescription').textContent = mode === 'create' ? "Pick your nickname and we'll set up a table for your crew." : "Enter your friend's room code and we'll pull up a seat.";
    $('confirmRoomAction').querySelector('span').textContent = mode === 'create' ? 'Create' : 'Join';
    $('joinCodeField').classList.toggle('is-hidden', mode !== 'join');
    $('roomCodeInput').value = '';
    openModal('roomSetupModal');
    window.setTimeout(() => $('playerNameInput').focus(), 100);
  }
  function submitRoomAction() {
    const name = $('playerNameInput').value.trim();
    if (!name) { toast('Enter a nickname first.', 'warning'); $('playerNameInput').focus(); return; }
    if (name.length > 16) { toast('Your nickname can be up to 16 characters.', 'warning'); return; }
    localStorage.setItem('myweb-uno-name', name);
    initAudio();
    if (prefs.musicEnabled) startMusic();
    if (setupMode === 'create') {
      socket.emit('createRoom', { name, token: sessionToken });
    } else {
      const code = $('roomCodeInput').value.trim().toUpperCase();
      if (!code) { toast('Enter the six-character room code.', 'warning'); return; }
      socket.emit('joinRoom', { name, code, token: sessionToken });
    }
  }

  // Screen and menu events.
  function startExperience() {
    initAudio();
    if (prefs.musicEnabled) startMusic();
    showScreen('mainMenu');
    playSfx('click');
  }
  $('splashScreen').addEventListener('click', startExperience);
  window.addEventListener('resize', relayout, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => relayout()).observe($('field'));
  $('splashScreen').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') startExperience(); });
  $('pressStart').addEventListener('click', event => { event.stopPropagation(); startExperience(); });
  $('createRoomOpen').addEventListener('click', () => { playSfx('click'); openRoomSetup('create'); });
  $('joinRoomOpen').addEventListener('click', () => { playSfx('click'); openRoomSetup('join'); });
  $('confirmRoomAction').addEventListener('click', submitRoomAction);
  $('playerNameInput').value = localStorage.getItem('myweb-uno-name') || '';
  $('roomCodeInput').addEventListener('input', () => { $('roomCodeInput').value = $('roomCodeInput').value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 6); });
  $('playerNameInput').addEventListener('keydown', event => { if (event.key === 'Enter') submitRoomAction(); });
  $('roomCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') submitRoomAction(); });
  $('openSettings').addEventListener('click', () => { $('leaveGame').classList.add('is-hidden'); openModal('settingsModal'); });
  $('lobbySettings').addEventListener('click', () => { $('leaveGame').classList.add('is-hidden'); openModal('settingsModal'); });
  $('gameSettings').addEventListener('click', () => { $('leaveGame').classList.remove('is-hidden'); openModal('settingsModal'); });
  $('howToPlayOpen').addEventListener('click', () => openModal('howToPlayModal'));
  $('closeSettings').addEventListener('click', () => closeModal('settingsModal'));
  $('closeHowToPlay').addEventListener('click', () => closeModal('howToPlayModal'));
  $('backToMenu').addEventListener('click', () => {
    if (state?.code) socket.emit('leaveRoom');
    state = null; roomCode = ''; showScreen('mainMenu');
  });
  document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.closeModal)));
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', event => { if (event.target === backdrop && backdrop.id !== 'wildPicker') closeModal(backdrop.id); }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideAllModals(); });

  $('musicEnabled').addEventListener('change', event => { prefs.musicEnabled = event.target.checked; savePrefs(); if (prefs.musicEnabled) startMusic(); else stopMusic(); });
  $('sfxEnabled').addEventListener('change', event => { prefs.sfxEnabled = event.target.checked; savePrefs(); if (prefs.sfxEnabled) playSfx('click'); });
  $('musicVolume').addEventListener('input', event => { prefs.musicVolume = Number(event.target.value); savePrefs(); });
  $('sfxVolume').addEventListener('input', event => { prefs.sfxVolume = Number(event.target.value); savePrefs(); });
  $('reduceMotion').addEventListener('change', event => { prefs.reduceMotion = event.target.checked; savePrefs(); });

  for (const id of ['ruleStacking', 'ruleZeroSeven', 'ruleDrawUntil', 'ruleSixReaction']) $(id).addEventListener('change', updateHouseRules);
  $('startGame').addEventListener('click', () => { if (!state || state.hostId !== socket.id) return; socket.emit('startGame'); playSfx('click'); });
  $('copyRoomCode').addEventListener('click', async () => {
    const code = state?.code || roomCode;
    try { await navigator.clipboard.writeText(code); toast('Copied!', 'success'); }
    catch { window.prompt('Copy this room code:', code); }
  });
  $('leaveGame').addEventListener('click', () => {
    const button = $('leaveGame');
    const label = button.querySelector('span');
    if (!button.classList.contains('is-confirm')) {
      button.classList.add('is-confirm');
      label.textContent = 'Tap again to leave';
      leaveTimer = window.setTimeout(() => { button.classList.remove('is-confirm'); label.textContent = 'Leave table'; }, 3000);
      return;
    }
    clearTimeout(leaveTimer);
    button.classList.remove('is-confirm');
    label.textContent = 'Leave table';
    closeModal('settingsModal');
    socket.emit('leaveRoom');
    $('winOverlay').classList.add('is-hidden');
    state = null; roomCode = ''; lastGameSnapshot = null;
    showScreen('mainMenu');
  });

  $('drawPile').addEventListener('click', () => {
    if (director.running) return;
    if (!state?.game) return;
    if (state.game.pendingDraw > 0) socket.emit('drawPenalty');
    else socket.emit('drawCard');
    playSfx('draw');
  });
  $('passTurn').addEventListener('click', () => { if (!director.running) socket.emit('passTurn'); });
  $('takePenalty').addEventListener('click', () => { if (!director.running) socket.emit('drawPenalty'); });
  $('unoButton').addEventListener('click', () => { socket.emit('callUno'); playSfx('uno'); });
  $('challengeWildFour').addEventListener('click', () => { socket.emit('challengeWild4'); playSfx('action'); });
  $('acceptWildFour').addEventListener('click', () => { socket.emit('drawPenalty'); playSfx('draw'); });
  $('reactionOverlay').addEventListener('click', () => { const r = state?.game?.sixReaction; if (r?.active && srvNow() >= r.startsAt) { socket.emit('pressSix', r.id); playSfx('click'); } });
  (() => {
    document.querySelectorAll('.cube').forEach(cube => {
      cube.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); cube.click(); } });
    });
    const depth = $('wheelDepth');
    for (let i = 0; i < 14; i += 1) { const layer = document.createElement('i'); layer.style.setProperty('--i', String(i)); depth.appendChild(layer); }
    document.querySelectorAll('.wheel-slice, .cube').forEach(slice => {
      const tell = color => { if (!$('wildPicker').classList.contains('is-remote')) socket.emit('wildPicking', { active: true, hover: color, kind: pendingWildKind }); };
      slice.addEventListener('pointerenter', () => tell(slice.dataset.wildColor));
      slice.addEventListener('pointerleave', () => tell(null));
    });
    const stack = $('drawStack');
    for (let i = 13; i >= 1; i -= 1) {
      const layer = document.createElement('i');
      layer.style.setProperty('--i', String(i));
      layer.style.setProperty('--c', i % 3 === 0 ? '#b9bcc6' : '#f2f2f4');
      stack.appendChild(layer);
    }
    initParticles();
  })();
  // Subtle floating decorations around the table (squares, diamonds, fragments, glows).
  function initParticles() {
    const host = $('fieldParticles');
    if (!host || host.childElementCount) return;
    const kinds = ['ptc-sq', 'ptc-dia', 'ptc-frag', 'ptc-dot'];
    let made = 0, tries = 0;
    while (made < 22 && tries < 400) {
      tries += 1;
      const x = Math.random() * 100, y = Math.random() * 100;
      if (((x - 50) / 47) ** 2 + ((y - 51) / 40) ** 2 < 1) continue; // keep the tabletop clear
      const kind = kinds[made % kinds.length];
      const el = document.createElement('i');
      el.className = `${kind}${made % 7 === 0 ? ' ptc-soft' : ''}`;
      const size = kind === 'ptc-dot' ? 10 + Math.random() * 26 : 12 + Math.random() * 34;
      const set = (k, v) => el.style.setProperty(k, v);
      set('--x', `${x}%`); set('--y', `${y}%`); set('--s', `${size}px`); set('--o', (0.25 + Math.random() * 0.5).toFixed(2));
      set('--r', `${Math.round(Math.random() * 90 - 20)}deg`); set('--t', `${14 + Math.random() * 14}s`); set('--d', `${-Math.random() * 14}s`);
      set('--dx', `${Math.round(Math.random() * 40 - 20)}px`); set('--dy', `${Math.round(Math.random() * 50 - 25)}px`);
      host.appendChild(el);
      made += 1;
    }
  }
  socket.on('wildPicking', data => {
    if (!data || data.playerId === socket.id) return;
    const stage = $('wildPicker');
    if (!data.active) { stage.classList.add('is-hidden'); stage.classList.remove('is-remote'); return; }
    if (stage.classList.contains('is-hidden')) { stage.style.animation = 'none'; void stage.offsetWidth; stage.style.animation = ''; }
    stage.classList.remove('is-hidden');
    stage.classList.add('is-remote');
    stage.classList.toggle('is-wild4', data.kind === 'wild4');
    stage.querySelectorAll('[data-wild-color]').forEach(slice => slice.classList.toggle('is-hover', slice.dataset.wildColor === data.hover));
  });
  $('cancelWild').addEventListener('click', () => { pendingWildCardId = null; closeWildWheel(); });
  $('cancelWild4').addEventListener('click', () => { pendingWildCardId = null; closeWildWheel(); });
  document.querySelectorAll('[data-wild-color]').forEach(button => button.addEventListener('click', () => {
    const color = button.dataset.wildColor;
    const cardId = pendingWildCardId;
    pendingWildCardId = null;
    closeWildWheel();
    if (cardId) socket.emit('playCard', { cardId, color });
    playSfx('action');
  }));
  $('backToLobby').addEventListener('click', () => {
    $('winOverlay').classList.add('is-hidden');
    socket.emit('leaveRoom');
    state = null; roomCode = ''; lastWinnerShown = null;
    showScreen('mainMenu');
  });

  // Click anywhere to skip the current animation sequence.
  document.addEventListener('pointerdown', () => director.fastForward(), true);

  // Hand interaction: hover is resolved from layout (hitTestHand), clicks use the same hit-test.
  (() => {
    const hand = $('myHand');
    hand.tabIndex = 0;
    hand.addEventListener('pointermove', event => {
      lastPointerType = event.pointerType || 'mouse';
      if (lastPointerType === 'touch' && event.buttons === 0) return;
      setHover(hitTestHand(event));
    });
    hand.addEventListener('pointerdown', event => {
      lastPointerType = event.pointerType || 'mouse';
      setHover(hitTestHand(event));
    });
    hand.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') setHover(-1); });
    hand.addEventListener('click', event => {
      const index = hitTestHand(event);
      if (index < 0) return;
      const card = handView.cards[index];
      const element = handView.els[index];
      if (!card) return;
      if (lastPointerType === 'touch' && armedId !== card.id) {
        // First tap lifts the card so you can read it; second tap plays it.
        armedId = card.id;
        setHover(index);
        return;
      }
      onCardChosen(card, element);
    });
    hand.addEventListener('keydown', event => {
      const count = handView.cards.length;
      if (!count) return;
      if (event.key === 'ArrowRight') { setHover(Math.min(count - 1, hoverIndex < 0 ? 0 : hoverIndex + 1)); event.preventDefault(); }
      else if (event.key === 'ArrowLeft') { setHover(Math.max(0, hoverIndex < 0 ? count - 1 : hoverIndex - 1)); event.preventDefault(); }
      else if ((event.key === 'Enter' || event.key === ' ') && hoverIndex >= 0) { onCardChosen(handView.cards[hoverIndex], handView.els[hoverIndex]); event.preventDefault(); }
      else if (event.key === 'Escape') setHover(-1);
    });
    hand.addEventListener('blur', () => { if (lastPointerType !== 'touch') setHover(-1); });
    document.addEventListener('pointerdown', event => {
      if (!hand.contains(event.target)) { armedId = null; if (event.pointerType === 'touch') setHover(-1); }
    });
  })();

  // Real-time connection and server-authoritative state.
  socket.on('connected', () => socket.emit('resumeSession', sessionToken));
  socket.on('resumeFailed', () => {
    // A clean server restart may have lost its in-memory room. Keep the token
    // for future room creation, but do not pretend the former table survived.
    if (state?.code) { state = null; roomCode = ''; showScreen('mainMenu'); }
  });
  socket.on('roomJoined', data => {
    roomCode = data.code;
    if (data.token) { sessionToken = data.token; localStorage.setItem(TOKEN_KEY, sessionToken); }
    closeModal('roomSetupModal');
  });
  socket.on('roomLeft', () => { state = null; roomCode = ''; showScreen('mainMenu'); });
  socket.on('state', applyState);
  const inGame = () => document.body.dataset.screen === 'gameScreen';
  socket.on('toast', data => {
    const text = data?.text || 'Something went wrong.';
    if (inGame()) flash(text); else toast(text, data?.kind || 'warning');
    if ((data?.kind || 'warning') === 'warning') playSfx('error');
  });
  // Server 'notice' events are intentionally not shown: seat bubbles, card flights and the status line already convey them.
  socket.on('connect_error', () => { if (inGame()) flash('Reconnecting…', 2500); else toast('Connection hiccup. Trying to reconnect…', 'warning'); });
  socket.on('reconnect', () => { socket.emit('resumeSession', sessionToken); });

  updateAudioControls();
  activateTextureCardBack();
  document.documentElement.classList.toggle('reduce-motion', Boolean(prefs.reduceMotion));
  showScreen('splashScreen');
})();
