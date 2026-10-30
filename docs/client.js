'use strict';

(() => {
  const socket = io();
  const $ = id => document.getElementById(id);
  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const COLOR_LABELS = { red: 'RED', yellow: 'YELLOW', green: 'GREEN', blue: 'BLUE' };
  const COLOR_HEX = { red: '#f3293f', yellow: '#ffd92f', green: '#22aa66', blue: '#147bd1' };
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
    ['roomSetupModal', 'settingsModal', 'howToPlayModal', 'wildPicker'].forEach(closeModal);
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
  function layoutField() {
    const field = $('field');
    if (!field) return;
    const W = field.clientWidth, H = field.clientHeight;
    if (!W || !H) return;
    const portrait = H > W * 1.05;
    const handH = clampNum(84, portrait ? Math.min(W * 0.29, H * 0.16) : Math.min(H * 0.225, W * 0.13), 210);
    const handW = Math.round(handH * 0.649);
    const pileH = clampNum(78, portrait ? Math.min(W * 0.28, H * 0.15) : Math.min(H * 0.215, W * 0.12), 200);
    const pileW = Math.round(pileH * 0.649);
    const oppH = clampNum(44, handH * 0.46, 100);
    const oppW = Math.round(oppH * 0.649);
    const av = clampNum(34, oppH * 0.78, 72);
    const ring = Math.max(pileH * 1.95, Math.min(pileH * 2.2, W * 0.8, H * 0.5));
    const set = (k, v) => field.style.setProperty(k, `${Math.round(v)}px`);
    set('--hand-h', handH); set('--hand-w', handW); set('--pile-h', pileH); set('--pile-w', pileW);
    set('--opp-h', oppH); set('--opp-w', oppW); set('--av', av); set('--ring', ring);
    field.classList.toggle('is-portrait', portrait);
    layout = { W, H, handH, handW, pileH, pileW, oppH, oppW, av, portrait };
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

  function flyCard({ card, back = false, from, to, rotFrom = 0, rotTo = 0, duration = 440, delay = 0 }) {
    if (prefs.reduceMotion) return 0;
    const el = back ? makeCardBack() : createCardElement(card);
    el.classList.add('flying-card');
    el.style.width = `${from.w}px`; el.style.height = `${from.h}px`;
    el.style.left = `${from.x - from.w / 2}px`; el.style.top = `${from.y - from.h / 2}px`;
    $('cardFlightLayer').appendChild(el);
    const dx = to.x - from.x, dy = to.y - from.y, s = to.w / from.w;
    el.animate([
      { transform: `translate(0px, 0px) rotate(${rotFrom}deg) scale(1)` },
      { transform: `translate(${dx * .5}px, ${dy * .5 - 22}px) rotate(${(rotFrom + rotTo) / 2}deg) scale(${((1 + s) / 2) * 1.04})`, offset: .55 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${rotTo}deg) scale(${s})` },
    ], { duration, delay, easing: 'cubic-bezier(.22,.8,.25,1)', fill: 'both' }).onfinish = () => el.remove();
    return duration + delay;
  }
  const pileTarget = () => {
    const rect = $('discardPile').getBoundingClientRect();
    return { ...centerOf(rect), w: rect.width, h: rect.height };
  };
  const drawPileSource = () => {
    const rect = $('drawPile').getBoundingClientRect();
    return { ...centerOf(rect), w: rect.width, h: rect.height };
  };

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
      $('wildPicker').classList.remove('is-hidden');
      playSfx('click');
      applyHandTransforms();
      return;
    }
    playSfx(['Draw2', 'Wild4', 'Skip', 'Reverse'].includes(card.value) ? 'action' : 'card');
    socket.emit('playCard', { cardId: card.id });
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
    $('playerCount').textContent = `${next.players.length}/5`;
    const isHost = socket.id === next.hostId;
    $('hostBadge').classList.toggle('is-hidden', !isHost);
    $('rulesLockLabel').textContent = isHost ? 'HOST ONLY' : 'VIEW ONLY';
    $('lobbyPlayers').replaceChildren();
    const palette = ['red', 'blue', 'yellow', 'green', 'purple'];
    next.players.forEach((player, index) => {
      const row = document.createElement('div');
      row.className = `lobby-player-row${player.id === next.hostId ? ' player-is-host' : ''}${!player.connected ? ' player-offline' : ''}`;
      const avatar = document.createElement('span');
      avatar.className = `avatar avatar-${palette[index % palette.length]}`;
      avatar.textContent = player.name.slice(0, 1).toUpperCase();
      const identity = document.createElement('div');
      identity.className = 'lobby-player-identity';
      const name = document.createElement('b');
      name.textContent = player.name + (player.id === socket.id ? ' (you)' : '');
      const status = document.createElement('small');
      status.textContent = !player.connected ? 'Reconnecting…' : player.id === next.hostId ? 'HOST · DEALER' : 'READY TO PLAY';
      identity.append(name, status);
      const right = document.createElement('span');
      right.className = 'player-status-icon';
      right.textContent = !player.connected ? '…' : player.id === next.hostId ? '★' : '✓';
      row.append(avatar, identity, right);
      $('lobbyPlayers').appendChild(row);
    });
    const canStart = isHost && next.players.length >= 2;
    $('startGame').disabled = !canStart;
    $('startGame').classList.toggle('btn-disabled', !canStart);
    $('lobbyHint').textContent = !isHost ? 'Waiting for the host to deal the cards…' : next.players.length < 2 ? 'Waiting for one more player…' : 'Everyone is here. Deal whenever you are ready.';
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
     Opponents — face-down fans arranged around the table edge.
     Seats run clockwise from you, so turn order reads naturally.
  ------------------------------------------------------------------- */
  function fillSeatHand(handEl, count, seatClass) {
    const { oppW, oppH } = layout;
    const shown = Math.min(count, 10);
    const step = Math.min(oppW * 0.4, 22);
    const span = Math.max(0, (shown - 1) * step);
    const angStep = Math.min(5, 34 / Math.max(shown, 1));
    const sideways = seatClass === 'seat-left' || seatClass === 'seat-right';
    handEl.style.width = `${sideways ? oppH + 12 : span + oppW + 10}px`;
    handEl.style.height = `${sideways ? span + oppW + 10 : oppH + 12}px`;
    handEl.replaceChildren();
    for (let i = 0; i < shown; i += 1) {
      const off = i - (shown - 1) / 2;
      const arc = off * off * 0.9;
      const back = makeCardBack();
      back.classList.add('mini-card');
      let transform;
      if (seatClass === 'seat-left') transform = `translate(${-arc}px, ${off * step}px) rotate(${90 + off * angStep}deg)`;
      else if (seatClass === 'seat-right') transform = `translate(${arc}px, ${off * step}px) rotate(${-90 + off * angStep}deg)`;
      else transform = `translate(${off * step}px, ${arc}px) rotate(${180 + off * angStep}deg)`;
      back.style.transform = transform;
      back.style.zIndex = String(i);
      handEl.appendChild(back);
    }
  }

  function renderOpponents(next) {
    const game = next.game;
    const meIndex = next.players.findIndex(player => player.id === socket.id);
    const total = next.players.length;
    const others = next.players
      .map((player, index) => ({ player, order: (index - meIndex + total) % total }))
      .filter(entry => entry.player.id !== socket.id)
      .sort((a, b) => a.order - b.order)
      .map(entry => entry.player);
    const seatMaps = {
      1: ['seat-top'],
      2: ['seat-top-left', 'seat-top-right'],
      3: ['seat-left', 'seat-top', 'seat-right'],
      4: ['seat-left', 'seat-top-left', 'seat-top-right', 'seat-right'],
    };
    const seats = seatMaps[others.length] || seatMaps[4];
    const container = $('opponents');
    container.replaceChildren();
    const challenge = game?.unoChallenge && Date.now() <= game.unoChallenge.deadline ? game.unoChallenge : null;
    others.forEach((player, index) => {
      const seatClass = seats[index] || 'seat-top';
      const seat = document.createElement('div');
      seat.className = `seat ${seatClass}${player.isTurn && !game.winnerId ? ' opp-active' : ''}${!player.connected ? ' opp-offline' : ''}`;
      seat.dataset.playerId = player.id;
      const hand = document.createElement('div');
      hand.className = 'seat-hand';
      fillSeatHand(hand, player.count, seatClass);
      const id = document.createElement('div');
      id.className = 'seat-id';
      const avatar = document.createElement('span');
      avatar.className = 'seat-avatar';
      avatar.textContent = player.name.slice(0, 1).toUpperCase();
      const count = document.createElement('i');
      count.className = 'seat-count';
      count.textContent = String(player.count);
      avatar.appendChild(count);
      const name = document.createElement('span');
      name.className = 'seat-name';
      name.textContent = player.connected ? player.name : `${player.name} …`;
      id.append(avatar, name);
      if (challenge && challenge.targetId === player.id) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'catch-chip';
        chip.textContent = 'CATCH!';
        chip.addEventListener('click', () => { socket.emit('catchUno', player.id); playSfx('action'); chip.remove(); });
        id.appendChild(chip);
      }
      seat.append(id, hand);
      if (game?.awaitingSwapPlayerId === socket.id) {
        seat.classList.add('swap-target');
        seat.tabIndex = 0;
        seat.setAttribute('role', 'button');
        seat.setAttribute('aria-label', `Swap hands with ${player.name}`);
        seat.addEventListener('click', () => socket.emit('swapHands', player.id));
        seat.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') socket.emit('swapHands', player.id); });
      }
      container.appendChild(seat);
    });
    if (unoChallengeTicker) { clearTimeout(unoChallengeTicker); unoChallengeTicker = null; }
    if (challenge) {
      unoChallengeTicker = window.setTimeout(() => document.querySelectorAll('.catch-chip').forEach(chip => chip.remove()), Math.max(0, challenge.deadline - Date.now() + 15));
    }
  }

  function seatBubble(playerId, text, kind = '') {
    const seat = document.querySelector(`.seat[data-player-id="${CSS.escape(playerId)}"] .seat-id`);
    if (!seat) return;
    const bubble = document.createElement('span');
    bubble.className = `seat-bubble ${kind}`;
    bubble.textContent = text;
    seat.appendChild(bubble);
    window.setTimeout(() => bubble.remove(), 1600);
  }

  /* ------------------------------------------------------------------
     Your hand.
     Hover is resolved from the pointer's X position against the *layout*
     (never against transformed card boxes), so lifting/spreading a card can
     never change which card is under the cursor. That is what removes the
     flicker and the "neighbour steals the hover" problem near the middle.
  ------------------------------------------------------------------- */
  const COLOR_ORDER = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const VALUE_ORDER = { Skip: 10, Reverse: 11, Draw2: 12, Wild: 20, Wild4: 21 };
  function sortHand(hand) {
    const rank = card => (COLOR_ORDER[card.color] ?? 5) * 100 + (VALUE_ORDER[card.value] ?? (Number(card.value) || 0));
    return [...hand].sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
  }

  function handMetrics(count) {
    const { W, handW, portrait } = layout;
    const avail = portrait ? W * 0.94 : Math.min(W * 0.64, 1120);
    const step = count > 1 ? Math.min(handW * 0.62, (avail - handW) / (count - 1)) : 0;
    const total = step * Math.max(0, count - 1) + handW;
    return { step, total, left: -total / 2 };
  }

  function hitTestHand(event) {
    const count = handView.cards.length;
    if (!count || !layout) return -1;
    const rect = $('myHand').getBoundingClientRect();
    const { handH } = layout;
    const baseTop = rect.bottom - handH * 1.1;
    if (event.clientY < baseTop - handH * 0.3 * 0.75 || event.clientY > rect.bottom) return -1;
    const { step, total, left } = handMetrics(count);
    const relX = event.clientX - (rect.left + rect.width / 2);
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
    const lift = handH * 0.3;
    const arcK = count > 8 ? 0.55 : 0.9;
    const angStep = Math.min(3, 30 / Math.max(count, 1));
    const spread = clampNum(handW * 0.15, handW * 0.9 - step, handW * 0.42);
    const falloff = [0, 1, 0.6, 0.3, 0.12, 0.05];
    els.forEach((el, i) => {
      const off = i - (count - 1) / 2;
      let x = off * step;
      let y = Math.pow(Math.abs(off), 1.6) * arcK;
      let angle = off * angStep;
      let scale = 1;
      if (el._playable) y -= handH * 0.06;
      if (hoverIndex >= 0) {
        if (i === hoverIndex) { y = -lift; angle = 0; scale = 1.14; }
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
          from: { ...centerOf(rect), w: layout.handW, h: layout.handH }, to: pileTarget(),
          rotTo: discardRot(game.lastCardId), duration: 420,
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

    // New cards slide in from the draw pile.
    if (fresh.length && !prefs.reduceMotion && layout) {
      const source = drawPileSource();
      fresh.forEach(({ element, index }, order) => {
        const rect = element.getBoundingClientRect();
        const c = centerOf(rect);
        const finalTransform = element.style.transform;
        element.animate([
          { transform: `translate(${source.x - c.x}px, ${source.y - c.y}px) rotate(-14deg) scale(${source.w / rect.width})`, opacity: .4 },
          { transform: finalTransform, opacity: 1 },
        ], { duration: 420, delay: Math.min(order * 70, 420), easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'backwards' });
      });
    }

    $('myHandCount').textContent = `${hand.length} ${hand.length === 1 ? 'CARD' : 'CARDS'}`;
    $('myAvatar').textContent = (me?.name || 'Y').slice(0, 1).toUpperCase();
    $('myNameLabel').textContent = (me?.name || 'YOU').toUpperCase();
    $('youSeat').classList.toggle('is-turn', isMyTurn);

    const playableCount = hand.filter(card => localCanPlay(card, game, hand)).length;
    const canCallUno = isMyTurn && hand.length === 2 && playableCount > 0 && game.pendingDraw === 0 && !game.pendingWild4 && !game.drawnPlayableCardId;
    const uno = $('unoButton');
    uno.disabled = !canCallUno || Boolean(game.armedUno);
    uno.classList.toggle('uno-ready', canCallUno && !game.armedUno);
    uno.classList.toggle('uno-called', Boolean(game.armedUno));

    const drawButton = $('drawPile');
    drawButton.disabled = !isMyTurn || Boolean(game.winnerId) || Boolean(game.awaitingSwapPlayerId) || Boolean(game.sixReaction?.active) || Boolean(game.drawnPlayableCardId);
    drawButton.classList.toggle('draw-ready', isMyTurn && !playableCount && !game.pendingWild4 && !game.drawnPlayableCardId && !game.pendingDraw);
    drawButton.classList.toggle('draw-penalty', isMyTurn && game.pendingDraw > 0);
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

  function renderStatus(next) {
    if (Date.now() < statusOverrideUntil) return;
    const game = next.game;
    const el = $('tableMessage');
    const me = next.players.find(player => player.id === socket.id);
    const current = next.players[game.turn];
    let text = '';
    let mine = false;
    if (game.winnerId) text = `${game.winnerName} wins!`;
    else if (game.awaitingSwapPlayerId === socket.id) text = 'Pick a player to swap hands';
    else if (game.pendingWild4?.targetId === socket.id) text = 'Challenge the +4 or draw 4';
    else if (me?.isTurn && game.pendingDraw > 0) text = `Stack a +${game.pendingDraw === 2 ? 2 : 4} or take ${game.pendingDraw}`;
    else if (me?.isTurn) { text = game.drawnPlayableCardId ? 'Play it or pass' : 'Your turn'; mine = true; }
    else if (current) text = `${current.name}'s turn`;
    el.textContent = text;
    el.className = `status-line${mine ? ' is-mine' : ''}`;
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
      const miniCard = document.querySelector(`.seat[data-player-id="${CSS.escape(game.lastPlayerId)}"] .mini-card:last-child`)
        || document.querySelector(`.seat[data-player-id="${CSS.escape(game.lastPlayerId)}"] .seat-avatar`);
      if (miniCard && layout) {
        const rect = miniCard.getBoundingClientRect();
        flightThisRender = Math.max(flightThisRender, flyCard({
          card: game.top, from: { ...centerOf(rect), w: layout.oppW, h: layout.oppH }, to: pileTarget(),
          rotFrom: 180, rotTo: discardRot(game.lastCardId) + 360, duration: 480,
        }));
      }
    }

    $('gameRoomCode').textContent = next.code;
    renderOpponents(next);

    // Opponents drawing: cards travel from the deck to their seat.
    let anyOpponentDrew = false;
    next.players.forEach(player => {
      const before = prevCounts.get(player.id);
      if (!firstFrame && before !== undefined && player.count > before && player.id !== socket.id && layout) {
        const seat = document.querySelector(`.seat[data-player-id="${CSS.escape(player.id)}"] .seat-avatar`);
        if (seat) {
          const rect = seat.getBoundingClientRect();
          const amount = player.count - before;
          for (let i = 0; i < Math.min(amount, 4); i += 1) {
            flyCard({ back: true, from: drawPileSource(), to: { ...centerOf(rect), w: layout.oppW, h: layout.oppH }, rotTo: 180, duration: 420, delay: i * 90 });
          }
          seatBubble(player.id, `+${amount}`, amount >= 2 ? 'is-bad' : '');
          anyOpponentDrew = true;
        }
      }
    });
    if (anyOpponentDrew) playSfx('draw');
    prevCounts = new Map(next.players.map(player => [player.id, player.count]));

    renderHand(next);

    // Direction + colour.
    const color = COLOR_HEX[game.color] || COLOR_HEX.red;
    $('field').style.setProperty('--cur', color);
    $('dirRing').classList.toggle('is-reverse', game.direction === -1);
    $('deckCount').textContent = String(game.drawCount);

    // Discard pile — a few cards stacked with stable, slightly messy angles.
    const top = game.top;
    let isNewTop = false;
    if (top && top.id !== lastTopId) {
      const seed = hashId(top.id);
      discardStack.push({ card: top, rot: discardRot(top.id), dx: ((seed >> 5) % 13) - 6, dy: ((seed >> 9) % 11) - 5 });
      if (discardStack.length > 5) discardStack.shift();
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
      cardEl.style.width = '100%'; cardEl.style.height = '100%';
      if (!isTop) cardEl.style.filter = 'brightness(.82)';
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
      const caller = game.unoAnnouncement.playerId;
      showUnoSplash(caller === socket.id ? 'UNO!' : `${next.players.find(p => p.id === caller)?.name || 'PLAYER'}: UNO!`);
      playSfx('uno');
    }
    if (game.winnerId && lastWinnerShown !== `${game.roundId}:${game.winnerId}`) {
      lastWinnerShown = `${game.roundId}:${game.winnerId}`;
      showWinner(game.winnerId === socket.id, game.winnerName);
    }
    if (lastGameSnapshot && game.lastCardId && game.lastCardId !== lastGameSnapshot.lastCardId) {
      playSfx(['Skip', 'Reverse', 'Draw2', 'Wild4'].includes(game.lastAction) ? 'action' : 'card');
    }
    lastGameSnapshot = { lastCardId: game.lastCardId, lastAction: game.lastAction };
  }

  function showUnoSplash(caption) {
    $('unoSplashCaption').textContent = caption;
    const splash = $('unoSplash');
    splash.classList.remove('is-hidden');
    splash.classList.remove('uno-splash-in');
    void splash.offsetWidth;
    splash.classList.add('uno-splash-in');
    window.setTimeout(() => splash.classList.add('is-hidden'), prefs.reduceMotion ? 600 : 1150);
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
    $('setupTitle').textContent = mode === 'create' ? 'Create a room' : 'Join your crew';
    $('setupEyebrow').textContent = mode === 'create' ? 'MAKE IT A PRIVATE TABLE' : 'YOU HAVE AN INVITATION';
    $('setupDescription').textContent = mode === 'create' ? "Pick your nickname and we'll set up a table for your crew." : "Enter your friend's room code and we'll pull up a seat.";
    $('confirmRoomAction').querySelector('span').textContent = mode === 'create' ? 'Create private room' : 'Join the table';
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
  $('openSettings').addEventListener('click', () => openModal('settingsModal'));
  $('lobbySettings').addEventListener('click', () => openModal('settingsModal'));
  $('gameSettings').addEventListener('click', () => openModal('settingsModal'));
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
    try { await navigator.clipboard.writeText(code); toast('Room code copied. Send it to your friends!', 'success'); }
    catch { window.prompt('Copy this room code:', code); }
  });
  $('leaveGame').addEventListener('click', () => {
    const button = $('leaveGame');
    const label = button.querySelector('em');
    if (!button.classList.contains('is-confirm')) {
      button.classList.add('is-confirm');
      label.textContent = 'Tap again to leave';
      leaveTimer = window.setTimeout(() => { button.classList.remove('is-confirm'); label.textContent = 'Leave'; }, 3000);
      return;
    }
    clearTimeout(leaveTimer);
    button.classList.remove('is-confirm');
    label.textContent = 'Leave';
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
  $('cancelWild').addEventListener('click', () => { pendingWildCardId = null; closeModal('wildPicker'); });
  document.querySelectorAll('[data-wild-color]').forEach(button => button.addEventListener('click', () => {
    const color = button.dataset.wildColor;
    const cardId = pendingWildCardId;
    pendingWildCardId = null;
    closeModal('wildPicker');
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
