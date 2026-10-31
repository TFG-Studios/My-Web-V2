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

  function cardFile(card) {
    if (!card) return null;
    if (card.color === 'wild') return card.value === 'Wild4' ? 'W4.png' : 'WC.png';
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
    const filename = cardFile(card);
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
    renderOpponents(state);
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

  function flyCard({ card, back = false, from, to, rotFrom = 0, rotTo = 0, duration = 440, delay = 0, tilt = 0 }) {
    if (prefs.reduceMotion) return 0;
    const el = back ? makeCardBack() : createCardElement(card);
    el.classList.add('flying-card');
    el.style.width = `${from.w}px`; el.style.height = `${from.h}px`;
    el.style.left = `${from.x - from.w / 2}px`; el.style.top = `${from.y - from.h / 2}px`;
    $('cardFlightLayer').appendChild(el);
    const dx = to.x - from.x, dy = to.y - from.y, s = to.w / from.w;
    el.animate([
      { transform: `perspective(1100px) translate(0px, 0px) rotate(${rotFrom}deg) scale(1) rotateX(0deg)` },
      { transform: `perspective(1100px) translate(${dx * .5}px, ${dy * .5 - 40}px) rotate(${(rotFrom + rotTo) / 2}deg) scale(${((1 + s) / 2) * 1.08}) rotateX(${tilt * .4}deg)`, offset: .55 },
      { transform: `perspective(1100px) translate(${dx}px, ${dy}px) rotate(${rotTo}deg) scale(${s}) rotateX(${tilt}deg)` },
    ], { duration, delay, easing: 'cubic-bezier(.22,.8,.25,1)', fill: 'both' }).onfinish = () => el.remove();
    return duration + delay;
  }
  const pileTarget = () => ({ ...centerOf($('discardPile').getBoundingClientRect()), w: layout.pileW * layout.s, h: layout.pileH * layout.s });
  const drawPileSource = () => ({ ...centerOf($('deck3d').getBoundingClientRect()), w: layout.deckW * layout.s, h: layout.deckH * layout.s });

  /* ------------------------------------------------------------------
     Choosing a card
  ------------------------------------------------------------------- */
  function onCardChosen(card, element) {
    if (!state?.game || state.game.winnerId) return;
    const me = state.players.find(player => player.id === socket.id);
    if (!me?.isTurn) { rejectCard(element); return flash('Wait for your turn'); }
    if (!localCanPlay(card, state.game, state.game.hand || [])) {
      rejectCard(element);
      return;
    }
    hoverIndex = -1; armedId = null;
    if (card.color === 'wild') {
      pendingWildCardId = card.id;
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
    socket.emit('wildPicking', { active: true });
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
     Opponents — one generic, seat-driven renderer.
     Each seat = fan of face-down cards (+ mirrored reflection) and a separate panel.
  ------------------------------------------------------------------- */
  function buildFan(count, cfg) {
    const { oppW, oppH, portrait } = layout;
    const shown = Math.min(count, 14);
    const fan = document.createElement('div');
    fan.className = 'fan';
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
    cards.forEach((c, i) => {
      const back = makeCardBack();
      back.classList.add('mini-card');
      back.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) rotate(${c.r.toFixed(1)}deg)`;
      back.style.zIndex = String(i);
      fan.appendChild(back);
    });
    return { fan, boxW, boxH };
  }

  function renderOpponents(next) {
    const game = next.game;
    const meIndex = next.players.findIndex(player => player.id === socket.id);
    const total = next.players.length;
    const others = next.players
      .map((player, index) => ({ player, index, order: (index - meIndex + total) % total }))
      .filter(entry => entry.player.id !== socket.id)
      .sort((a, b) => a.order - b.order);
    const seatMaps = { 1: ['top'], 2: ['left', 'right'], 3: ['left', 'top', 'right'], 4: ['left', 'tl', 'tr', 'right'] };
    const seats = seatMaps[others.length] || seatMaps[4];
    const cfgSet = layout.portrait ? SEAT_CFG.portrait : SEAT_CFG.landscape;
    $('stage').classList.toggle('seats-4', others.length === 4);
    const container = $('opponents');
    container.replaceChildren();
    const challenge = game?.unoChallenge && Date.now() <= game.unoChallenge.deadline ? game.unoChallenge : null;
    others.forEach(({ player, index }, order) => {
      const cfg = cfgSet[seats[order]] || cfgSet.top;
      const seat = document.createElement('div');
      seat.className = 'seat';
      seat.dataset.playerId = player.id;

      // fan + reflection
      const { fan, boxW, boxH } = buildFan(player.count, cfg);
      const wrap = document.createElement('div');
      wrap.className = 'seat-fan';
      wrap.style.cssText = `left:${cfg.hand[0]}%;top:${cfg.hand[1]}%;width:${boxW}px;height:${boxH}px;`;
      const tilt = cfg.kind === 'diag' ? ` perspective(900px) rotateY(${cfg.side < 0 ? 36 : -36}deg)` : '';
      wrap.style.transform = `translate(-50%, -50%)${tilt}`;
      const reflect = document.createElement('div');
      reflect.className = 'fan-reflect';
      reflect.setAttribute('aria-hidden', 'true');
      reflect.appendChild(fan.cloneNode(true));
      reflect.firstChild.className = 'fan';
      wrap.append(fan, reflect);

      // info panel
      const panel = document.createElement('div');
      panel.className = `seat-panel acc-${index % 5}${player.isTurn && !game.winnerId ? ' is-active' : ''}${!player.connected ? ' is-offline' : ''}`;
      panel.style.left = `${cfg.panel[0]}%`; panel.style.top = `${cfg.panel[1]}%`;
      const plate = document.createElement('span');
      plate.className = 'seat-plate';
      plate.textContent = player.name;
      const avatar = document.createElement('span');
      avatar.className = 'seat-avatar';
      avatar.appendChild(makeAvatarSvg(index));
      const count = document.createElement('b');
      count.className = 'seat-count';
      count.textContent = String(player.count);
      panel.append(plate, avatar, count);
      if (challenge && challenge.targetId === player.id) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'catch-chip';
        chip.textContent = 'CATCH!';
        chip.addEventListener('click', () => { socket.emit('catchUno', player.id); playSfx('action'); chip.remove(); });
        panel.appendChild(chip);
      }
      if (game?.awaitingSwapPlayerId === socket.id) {
        for (const target of [panel, wrap]) {
          target.classList.add('swap-target');
          target.style.pointerEvents = 'auto'; target.style.cursor = 'pointer';
          target.addEventListener('click', () => socket.emit('swapHands', player.id));
        }
        panel.tabIndex = 0; panel.setAttribute('role', 'button'); panel.setAttribute('aria-label', `Swap hands with ${player.name}`);
        panel.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') socket.emit('swapHands', player.id); });
      }
      seat.append(wrap, panel);
      container.appendChild(seat);
    });
    if (unoChallengeTicker) { clearTimeout(unoChallengeTicker); unoChallengeTicker = null; }
    if (challenge) {
      unoChallengeTicker = window.setTimeout(() => document.querySelectorAll('.catch-chip').forEach(chip => chip.remove()), Math.max(0, challenge.deadline - Date.now() + 15));
    }
  }

  function seatBubble(playerId, text, kind = '') {
    const panel = document.querySelector(`.seat[data-player-id="${CSS.escape(playerId)}"] .seat-panel`);
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
     All maths is in logical stage units; screen pixels are divided by layout.s.
  ------------------------------------------------------------------- */
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const VALUE_ORDER = { Skip: 10, Reverse: 11, Draw2: 12, Wild: 20, Wild4: 21 };
  const HAND_CENTER = 0.52; // hand centre as a fraction of stage width
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

  // Curved fan whose spacing, tilt and curvature are computed from the actual hand size.
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
      let x = off * step;
      let y = off * off * arcK;
      let angle = off * angStep;
      let scale = 1;
      if (el._playable) y -= 12;
      if (hoverIndex >= 0) {
        if (i === hoverIndex) { y = -lift; angle = 0; scale = 1.1; }
        else {
          const d = i - hoverIndex;
          x += Math.sign(d) * spread * (falloff[Math.min(Math.abs(d), 5)] || 0);
        }
      }
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${angle.toFixed(2)}deg) scale(${scale})`;
      el.style.zIndex = String(i === hoverIndex ? 1000 : i + 1);
      el.classList.toggle('is-hovered', i === hoverIndex);
      el.dataset.slot = String(i);
    });
  }

  function renderHand(next) {
    const game = next.game;
    const hand = sortHand(game.hand || []);
    const container = $('myHand');
    const me = next.players.find(player => player.id === socket.id);
    const meIndex = Math.max(0, next.players.findIndex(player => player.id === socket.id));
    const isMyTurn = Boolean(me?.isTurn && !game.winnerId);
    const oldElements = new Map([...container.querySelectorAll('[data-card-id]')].map(el => [el.dataset.cardId, el]));
    const newIds = new Set(hand.map(card => card.id));

    // Card I just played: fly it from the hand to the discard pile.
    if (game.lastCardId && game.lastCardId !== lastAnimatedCardId && game.lastPlayerId === socket.id && !newIds.has(game.lastCardId)) {
      const played = oldElements.get(game.lastCardId);
      if (played && layout) {
        const rect = played.getBoundingClientRect();
        flightThisRender = Math.max(flightThisRender, flyCard({
          card: game.top && game.top.id === game.lastCardId ? game.top : { id: game.lastCardId, color: 'wild', value: 'Wild' },
          from: { ...centerOf(rect), w: layout.handW * layout.s, h: layout.handH * layout.s }, to: pileTarget(),
          rotTo: Math.round(discardRot(game.lastCardId) * 1.7), duration: 420, tilt: 46,
        }));
      }
      lastAnimatedCardId = game.lastCardId;
    }
    for (const [id, element] of oldElements) if (!newIds.has(id)) element.remove();

    const els = [];
    const fresh = [];
    hand.forEach((card, index) => {
      let element = oldElements.get(card.id);
      if (!element) {
        element = createCardElement(card, { interactive: true });
        element.tabIndex = -1;
        container.appendChild(element);
        fresh.push({ element, index });
      }
      const playable = isMyTurn && localCanPlay(card, game, hand);
      element._playable = playable;
      element.classList.toggle('is-unplayable', isMyTurn && !playable);
      els.push(element);
    });
    handView = { cards: hand, els };
    if (hoverIndex >= hand.length) hoverIndex = hand.length - 1;
    if (!isMyTurn && armedId) armedId = null;
    applyHandTransforms();

    // New cards slide in from the draw deck.
    if (fresh.length && !prefs.reduceMotion && layout) {
      const source = drawPileSource();
      fresh.forEach(({ element }, order) => {
        const rect = element.getBoundingClientRect();
        const c = centerOf(rect);
        const finalTransform = element.style.transform;
        element.animate([
          { transform: `translate(${(source.x - c.x) / layout.s}px, ${(source.y - c.y) / layout.s}px) rotate(-14deg) scale(.7)`, opacity: .4 },
          { transform: finalTransform, opacity: 1 },
        ], { duration: 420, delay: Math.min(order * 70, 420), easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'backwards' });
      });
    }

    // Own panel (same visual language as the opponents').
    const youPanel = $('youSeat');
    $('myHandCount').textContent = String(hand.length);
    $('myNameLabel').textContent = me?.name || 'YOU';
    if (youPanel.dataset.avatar !== String(meIndex)) {
      youPanel.dataset.avatar = String(meIndex);
      $('myAvatar').replaceChildren(makeAvatarSvg(meIndex));
      youPanel.className = `seat-panel me acc-${meIndex % 5}`;
    }
    youPanel.classList.toggle('is-active', isMyTurn);

    const playableCount = hand.filter(card => localCanPlay(card, game, hand)).length;
    const canCallUno = isMyTurn && hand.length === 2 && playableCount > 0 && game.pendingDraw === 0 && !game.pendingWild4 && !game.drawnPlayableCardId;
    const uno = $('unoButton');
    uno.classList.toggle('is-hidden', !canCallUno);
    uno.disabled = Boolean(game.armedUno);
    uno.classList.toggle('is-called', Boolean(game.armedUno));

    const drawButton = $('drawPile');
    drawButton.disabled = !isMyTurn || Boolean(game.winnerId) || Boolean(game.awaitingSwapPlayerId) || Boolean(game.sixReaction?.active) || Boolean(game.drawnPlayableCardId);
    document.querySelector('.pile-draw').classList.toggle('draw-ready', isMyTurn && !playableCount && !game.pendingWild4 && !game.drawnPlayableCardId && !game.pendingDraw);
    const badge = $('drawBadge');
    badge.classList.toggle('is-hidden', !(game.pendingDraw > 0));
    if (game.pendingDraw > 0) badge.textContent = `+${game.pendingDraw}`;

    // Contextual pills — only present while they are actionable.
    const wildTarget = Boolean(isMyTurn && game.pendingWild4?.targetId === socket.id);
    $('passTurn').classList.toggle('is-hidden', !(isMyTurn && game.drawnPlayableCardId));
    $('takePenalty').classList.toggle('is-hidden', !(isMyTurn && game.pendingDraw > 0 && !game.pendingWild4));
    $('takePenalty').textContent = `Take ${game.pendingDraw}`;
    $('challengeWildFour').classList.toggle('is-hidden', !wildTarget);
    $('acceptWildFour').classList.toggle('is-hidden', !wildTarget);
  }

  // The only persistent text left on the table: the swap prompt (errors use flash()).
  function renderStatus(next) {
    if (Date.now() < statusOverrideUntil) return;
    const game = next.game;
    const el = $('tableMessage');
    el.textContent = !game.winnerId && game.awaitingSwapPlayerId === socket.id ? 'Pick a player to swap with' : '';
    el.className = 'status-line';
  }

  function renderGame(next) {
    const game = next.game;
    flightThisRender = 0;
    layoutField();
    if (discardRound !== game.roundId) {
      discardRound = game.roundId;
      discardStack = []; lastTopId = null; prevCounts = new Map(); lastAnimatedCardId = null;
      hoverIndex = -1; armedId = null; handView = { cards: [], els: [] };
      $('myHand').replaceChildren();
    }

    // Opponent plays a card: fly it out of their fan (before seats are rebuilt).
    const firstFrame = !lastGameSnapshot;
    if (!firstFrame && game.lastCardId && game.lastCardId !== lastGameSnapshot.lastCardId && game.lastPlayerId && game.lastPlayerId !== socket.id && game.top) {
      const sel = `.seat[data-player-id="${CSS.escape(game.lastPlayerId)}"]`;
      const source = document.querySelector(`${sel} .seat-fan > .fan > .mini-card:last-child`) || document.querySelector(`${sel} .seat-avatar`);
      if (source && layout) {
        const rect = source.getBoundingClientRect();
        flightThisRender = Math.max(flightThisRender, flyCard({
          card: game.top, from: { ...centerOf(rect), w: layout.oppW * layout.s, h: layout.oppH * layout.s }, to: pileTarget(),
          rotFrom: 0, rotTo: Math.round(discardRot(game.lastCardId) * 1.7) + 360, duration: 480, tilt: 46,
        }));
      }
    }

    $('gameRoomCode').textContent = next.code;
    renderOpponents(next);

    // Opponents drawing: cards travel from the deck to their avatar.
    let anyOpponentDrew = false;
    next.players.forEach(player => {
      const before = prevCounts.get(player.id);
      if (!firstFrame && before !== undefined && player.count > before && player.id !== socket.id && layout) {
        const target = document.querySelector(`.seat[data-player-id="${CSS.escape(player.id)}"] .seat-avatar`);
        if (target) {
          const rect = target.getBoundingClientRect();
          const amount = player.count - before;
          for (let i = 0; i < Math.min(amount, 4); i += 1) {
            flyCard({ back: true, from: drawPileSource(), to: { ...centerOf(rect), w: layout.oppW * layout.s, h: layout.oppH * layout.s }, rotTo: 0, duration: 420, delay: i * 90 });
          }
          seatBubble(player.id, `+${amount}`, amount >= 2 ? 'is-bad' : '');
          anyOpponentDrew = true;
        }
      }
    });
    if (anyOpponentDrew) playSfx('draw');
    prevCounts = new Map(next.players.map(player => [player.id, player.count]));

    renderHand(next);

    // Current colour tints the table rim + arrows; direction flips the arrows.
    $('field').style.setProperty('--cur', COLOR_HEX[game.color] || COLOR_HEX.red);
    $('dirRing').style.setProperty('--dir', game.direction === -1 ? '-1' : '1');
    $('deckCount').textContent = String(game.drawCount);

    // Discard pile — up to 7 recent cards, each with its own offset + rotation.
    const top = game.top;
    let isNewTop = false;
    if (top && top.id !== lastTopId) {
      const seed = hashId(top.id);
      discardStack.push({ card: top, rot: Math.round(discardRot(top.id) * 1.7), dx: ((seed >> 5) % 29) - 14, dy: ((seed >> 9) % 21) - 10 });
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
      const cardEl = createCardElement(entry.card);
      if (!isTop) cardEl.style.filter = `brightness(${(0.72 + 0.28 * (index / Math.max(1, discardStack.length - 1))).toFixed(2)})`;
      wrap.appendChild(cardEl);
      if (isTop && entry.card.color === 'wild') {
        const ring = document.createElement('i');
        ring.className = 'discard-wild-ring';
        wrap.appendChild(ring);
      }
      if (isTop && isNewTop && !firstFrame) {
        if (flightThisRender > 0) { wrap.style.visibility = 'hidden'; window.setTimeout(() => { wrap.style.visibility = ''; }, flightThisRender - 30); }
        else if (!prefs.reduceMotion) wrap.classList.add('is-new');
      }
      pile.appendChild(wrap);
    });

    renderStatus(next);

    // 6 Reaction — a round button on the table, not a screen-wide overlay.
    const reaction = game.sixReaction;
    const six = $('reactionOverlay');
    six.classList.toggle('is-hidden', !reaction?.active);
    if (reaction?.active) {
      const pressed = reaction.pressed.length;
      const total = reaction.playerIds.length;
      const safe = reaction.pressed.includes(socket.id);
      $('reactionStatus').textContent = safe ? `SAFE ${pressed}/${total}` : `${pressed}/${total} SAFE`;
      six.disabled = safe;
      six.classList.toggle('already-pressed', safe);
      $('reactionCountdown').textContent = String(Math.max(0, Math.ceil((reaction.deadline - Date.now()) / 1000)));
      if (!reactionTicker) {
        reactionTicker = window.setInterval(() => {
          const current = state?.game?.sixReaction;
          if (!current?.active) { clearInterval(reactionTicker); reactionTicker = null; return; }
          $('reactionCountdown').textContent = String(Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000)));
        }, 120);
      }
    } else if (reactionTicker) { clearInterval(reactionTicker); reactionTicker = null; }

    if (game.unoAnnouncement && game.unoAnnouncement.id !== lastUnoAnimationId) {
      lastUnoAnimationId = game.unoAnnouncement.id;
      showUnoFx(game.unoAnnouncement.playerId);
      playSfx('uno');
    }
    if (game.winnerId && lastWinnerShown !== `${game.roundId}:${game.winnerId}`) {
      lastWinnerShown = `${game.roundId}:${game.winnerId}`;
      showWinner(game.winnerId === socket.id, game.winnerName);
    }
    if (lastGameSnapshot && (game.lastCardId !== lastGameSnapshot.lastCardId || game.turn !== lastGameSnapshot.turn)) {
      const stage = $('wildPicker');
      if (stage.classList.contains('is-remote')) { stage.classList.add('is-hidden'); stage.classList.remove('is-remote'); }
    }
    if (lastGameSnapshot && game.lastCardId && game.lastCardId !== lastGameSnapshot.lastCardId) {
      playSfx(['Skip', 'Reverse', 'Draw2', 'Wild4'].includes(game.lastAction) ? 'action' : 'card');
    }
    lastGameSnapshot = { lastCardId: game.lastCardId, lastAction: game.lastAction, turn: game.turn };
  }

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
      const avatar = document.querySelector(`.seat[data-player-id="${CSS.escape(callerId)}"] .seat-avatar`);
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
    const wasStarted = Boolean(state?.started);
    state = next;
    roomCode = next.code || roomCode;
    if (next.started && next.game) {
      closeModal('roomSetupModal');
      showScreen('gameScreen');
      renderGame(next);
    } else {
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
    if (!state?.game) return;
    if (state.game.pendingDraw > 0) socket.emit('drawPenalty');
    else socket.emit('drawCard');
    playSfx('draw');
  });
  $('passTurn').addEventListener('click', () => socket.emit('passTurn'));
  $('takePenalty').addEventListener('click', () => socket.emit('drawPenalty'));
  $('unoButton').addEventListener('click', () => { socket.emit('callUno'); playSfx('uno'); });
  $('challengeWildFour').addEventListener('click', () => { socket.emit('challengeWild4'); playSfx('action'); });
  $('acceptWildFour').addEventListener('click', () => { socket.emit('drawPenalty'); playSfx('draw'); });
  $('reactionOverlay').addEventListener('click', () => { if (state?.game?.sixReaction?.active) socket.emit('pressSix', state.game.sixReaction.id); playSfx('reaction'); });
  (() => {
    const depth = $('wheelDepth');
    for (let i = 0; i < 14; i += 1) { const layer = document.createElement('i'); layer.style.setProperty('--i', String(i)); depth.appendChild(layer); }
    document.querySelectorAll('.wheel-slice').forEach(slice => {
      const tell = color => { if (!$('wildPicker').classList.contains('is-remote')) socket.emit('wildPicking', { active: true, hover: color }); };
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
    stage.classList.remove('is-hidden');
    stage.classList.add('is-remote');
    stage.querySelectorAll('.wheel-slice').forEach(slice => slice.classList.toggle('is-hover', slice.dataset.wildColor === data.hover));
  });
  $('cancelWild').addEventListener('click', () => { pendingWildCardId = null; closeWildWheel(); });
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
