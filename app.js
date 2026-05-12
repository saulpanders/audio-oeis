// Update this after deploying the Cloudflare Worker:
const WORKER_BASE = 'https://audio-oeis-prod.audioeis-live.workers.dev/?id=';

// On localhost, proxy.py serves /api/oeis so the browser never touches OEIS directly.
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);

function proxyUrl(oeisId) {
  if (IS_LOCAL) return `/api/oeis?id=${oeisId}`;
  return WORKER_BASE + oeisId;
}

// --- Constants ---

const SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  phrygian:   [0, 1, 3, 5, 7, 8, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian:    [0, 1, 3, 5, 6, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const TRACK_COLORS = [
  '#7c6cff', '#ff6c7c', '#6cffb8', '#ffb86c',
  '#6cb8ff', '#e06cff', '#6cffe0', '#ff6cc8',
];

const ADSR = { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.08 };
const LOOKAHEAD_MS   = 100;
const SCHEDULE_AHEAD = 0.15;

// --- Application state ---

const AppState = {
  tracks:        [],
  nextId:        0,
  bpm:           120,
  loop:          true,
  isPlaying:     false,
  audioCtx:      null,
  masterGain:    null,
  schedulerTimer: null,
  nextNoteTime:  0,
};

// --- Utilities ---

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function noteDuration() {
  return 60 / AppState.bpm;
}

// --- OEIS fetch ---

// AbortSignal.timeout() isn't in Safari < 15.4 or Firefox < 100;
// passing a reason to abort() also isn't universal, so keep it simple.
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function fetchOEIS(oeisId) {
  if (!/^A\d{1,6}$/i.test(oeisId)) throw new Error('ID must be A followed by up to 6 digits');
  const id = oeisId.toUpperCase();
  let resp;
  try {
    resp = await fetchWithTimeout(proxyUrl(id), 10000);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    if (IS_LOCAL) throw new Error('Proxy unreachable — run: python proxy.py');
    throw new Error('Network error: ' + (err.message || err));
  }
  if (!resp.ok) {
    if (resp.status === 404 && IS_LOCAL) {
      throw new Error('Got 404 — use proxy.py, not python -m http.server');
    }
    throw new Error('HTTP ' + resp.status);
  }
  const json = await resp.json();
  // OEIS now returns a bare array; older API returned { results: [...] }
  const results = Array.isArray(json) ? json : (json.results || []);
  if (results.length === 0) throw new Error('Sequence not found');
  const r = results[0];
  const terms = r.data.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  return { name: r.name, terms };
}

// --- Frequency mapping ---

function mapMidi(n) {
  return midiToFreq(Math.abs(n) % 128);
}

function mapDiatonic(n, rootNote, scale) {
  const len = scale.length;
  const degree = ((n % len) + len) % len;
  const octave = Math.floor(Math.abs(n) / len);
  const midi = clamp(rootNote + scale[degree] + octave * 12, 12, 120);
  return midiToFreq(midi);
}

function mapMicrotonal(terms, index, rootHz) {
  const a = terms[index];
  const b = terms[index + 1];
  if (b === undefined) return rootHz;
  const safeA = a === 0 ? 1 : Math.abs(a);
  const safeB = b === 0 ? 1 : Math.abs(b);
  let ratio = safeB / safeA;
  if (ratio > 4)    ratio = 1 + Math.log2(ratio) / 4;
  else if (ratio < 0.25) ratio = 1 / (1 + Math.log2(1 / ratio) / 4);
  return clamp(rootHz * ratio, 27.5, 4186);
}

function getFrequency(track, index) {
  if (track.terms.length === 0) return 440;
  const i = index % track.terms.length;
  const n = track.terms[i];
  const rootHz = midiToFreq(track.rootNote);
  switch (track.mappingMode) {
    case 'diatonic':   return mapDiatonic(n, track.rootNote, track.scale);
    case 'microtonal': return mapMicrotonal(track.terms, i, rootHz);
    default:           return mapMidi(n);
  }
}

// --- WAV encoding (inline, no CDN dependency) ---

function audioBufferToWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr    = buffer.sampleRate;
  const samples = numCh === 2
    ? interleaveChannels(buffer.getChannelData(0), buffer.getChannelData(1))
    : buffer.getChannelData(0);

  const dataLen = samples.length * 2; // 16-bit
  const ab  = new ArrayBuffer(44 + dataLen);
  const view = new DataView(ab);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = clamp(samples[i], -1, 1);
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return ab;
}

function interleaveChannels(L, R) {
  const out = new Float32Array(L.length + R.length);
  for (let i = 0, j = 0; i < L.length; i++) {
    out[j++] = L[i];
    out[j++] = R[i];
  }
  return out;
}

function writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// --- Playback engine ---

function initAudio() {
  if (AppState.audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  AppState.audioCtx = new Ctx();
  AppState.masterGain = AppState.audioCtx.createGain();
  AppState.masterGain.gain.value = 0.8;
  AppState.masterGain.connect(AppState.audioCtx.destination);
}

function createTrackGain(track) {
  const node = AppState.audioCtx.createGain();
  node.gain.value = track.muted ? 0 : track.volume;
  node.connect(AppState.masterGain);
  return node;
}

function scheduleNote(ctx, track, freq, startTime, destGain) {
  const dur = noteDuration();
  const sustainEnd = startTime + dur * 0.85;

  const osc = ctx.createOscillator();
  osc.type = track.waveform;
  osc.frequency.value = freq;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, startTime);
  env.gain.linearRampToValueAtTime(1, startTime + ADSR.attack);
  env.gain.linearRampToValueAtTime(ADSR.sustain, startTime + ADSR.attack + ADSR.decay);
  env.gain.setValueAtTime(ADSR.sustain, sustainEnd);
  env.gain.linearRampToValueAtTime(0, sustainEnd + ADSR.release);

  osc.connect(env);
  env.connect(destGain);
  osc.start(startTime);
  osc.stop(sustainEnd + ADSR.release + 0.01);
}

function scheduler() {
  const ctx = AppState.audioCtx;
  while (AppState.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
    const t = AppState.nextNoteTime;
    for (const track of AppState.tracks) {
      if (track.muted || track.terms.length === 0) continue;
      scheduleNote(ctx, track, getFrequency(track, track.noteIndex), t, track.gainNode);
      track.noteIndex++;
      if (track.noteIndex >= track.terms.length) {
        track.noteIndex = AppState.loop ? 0 : track.terms.length - 1;
      }
    }
    AppState.nextNoteTime += noteDuration();
  }
}

async function play() {
  initAudio();
  await AppState.audioCtx.resume();  // must await — Chrome starts AudioContext suspended
  for (const track of AppState.tracks) {
    track.noteIndex = 0;
    if (!track.gainNode) {
      track.gainNode = createTrackGain(track);
    } else {
      track.gainNode.gain.value = track.muted ? 0 : track.volume;
    }
  }
  AppState.masterGain.gain.cancelScheduledValues(AppState.audioCtx.currentTime);
  AppState.masterGain.gain.value = 0.8;
  AppState.nextNoteTime = AppState.audioCtx.currentTime + 0.05;
  AppState.isPlaying = true;
  scheduler();  // schedule first batch now; setInterval alone would fire 100ms late
  AppState.schedulerTimer = setInterval(scheduler, LOOKAHEAD_MS);
  updateTransportUI();
}

function stop() {
  clearInterval(AppState.schedulerTimer);
  AppState.isPlaying = false;
  if (AppState.masterGain) {
    const now = AppState.audioCtx.currentTime;
    AppState.masterGain.gain.linearRampToValueAtTime(0, now + 0.05);
    setTimeout(() => {
      AppState.masterGain.gain.value = 0.8;
      for (const track of AppState.tracks) track.noteIndex = 0;
    }, 100);
  }
  updateTransportUI();
}

function syncTrackGain(track) {
  if (!track.gainNode) return;
  track.gainNode.gain.linearRampToValueAtTime(
    track.muted ? 0 : track.volume,
    AppState.audioCtx.currentTime + 0.01
  );
}

function updateTransportUI() {
  const btnPlay = document.getElementById('btn-play');
  const btnStop = document.getElementById('btn-stop');
  btnPlay.textContent = AppState.isPlaying ? '⏸ Pause' : '▶ Play';
  btnStop.disabled = !AppState.isPlaying;
}

// --- Export ---

async function renderOffline(totalSecs) {
  const sr = AppState.audioCtx ? AppState.audioCtx.sampleRate : 44100;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const offCtx = new OfflineCtx(2, Math.ceil(totalSecs * sr), sr);

  const master = offCtx.createGain();
  master.gain.value = 0.8;
  master.connect(offCtx.destination);

  const dur = noteDuration();

  for (const track of AppState.tracks) {
    if (track.muted || track.terms.length === 0) continue;
    const tg = offCtx.createGain();
    tg.gain.value = track.volume;
    tg.connect(master);
    let t = 0, idx = 0;
    while (t < totalSecs) {
      scheduleNote(offCtx, track, getFrequency(track, idx), t, tg);
      t += dur;
      idx = (idx + 1) % track.terms.length;
    }
  }

  return offCtx.startRendering();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function setExportStatus(msg) {
  document.getElementById('export-status').textContent = msg;
}

async function exportWAV(bars) {
  const totalSecs = bars * 4 * noteDuration();
  setExportStatus('Rendering...');
  try {
    const buf = await renderOffline(totalSecs);
    const wavBytes = audioBufferToWav(buf);
    triggerDownload(new Blob([wavBytes], { type: 'audio/wav' }), 'oeis-sequence.wav');
    setExportStatus('');
  } catch (err) {
    setExportStatus('Export failed: ' + err.message);
  }
}


// --- Track UI ---

function applyTermLimit(track, card) {
  track.terms = track.termLimit != null
    ? track.allTerms.slice(0, track.termLimit)
    : track.allTerms.slice();
  track.noteIndex = 0;
  const n = track.terms.length;
  const preview = track.terms.slice(0, 16).join(', ') + (n > 16 ? ', ...' : '');
  card.querySelector('.lbl-terms').textContent = preview;
}

function createTrack() {
  const track = {
    id:          AppState.nextId++,
    oeisId:      '',
    name:        '',
    allTerms:    [],
    terms:       [],
    termLimit:   null,
    mappingMode: 'diatonic',
    rootNote:    60,
    scale:       SCALES.major,
    waveform:    'sine',
    volume:      0.7,
    muted:       false,
    color:       TRACK_COLORS[AppState.tracks.length % TRACK_COLORS.length],
    noteIndex:   0,
    gainNode:    null,
  };
  AppState.tracks.push(track);
  renderTrackCard(track);
  return track;
}

function renderTrackCard(track) {
  const frag = document.getElementById('track-template').content.cloneNode(true);
  const card = frag.firstElementChild;
  card.dataset.trackId = track.id;
  card.style.setProperty('--track-color', track.color);

  const selRoot = card.querySelector('.sel-root');
  for (let midi = 12; midi <= 108; midi++) {
    const opt = document.createElement('option');
    opt.value = midi;
    opt.textContent = NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
    if (midi === track.rootNote) opt.selected = true;
    selRoot.appendChild(opt);
  }

  const selScale = card.querySelector('.sel-scale');
  for (const name of Object.keys(SCALES)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    selScale.appendChild(opt);
  }

  // Sync dropdown and visibility to initial track state
  card.querySelector('.sel-mode').value = track.mappingMode;
  card.querySelector('.root-group').classList.toggle('hidden', track.mappingMode !== 'diatonic');

  const oeisInput = card.querySelector('.inp-oeis-id');
  oeisInput.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
  oeisInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleFetch(track, card);
  });

  card.querySelector('.btn-fetch').addEventListener('click', () => handleFetch(track, card));

  card.querySelector('.inp-term-limit').addEventListener('change', e => {
    const val = parseInt(e.target.value, 10);
    track.termLimit = (isNaN(val) || val < 1) ? null : val;
    if (track.allTerms.length > 0) {
      applyTermLimit(track, card);
      const statusEl = card.querySelector('.track-status');
      statusEl.textContent = track.terms.length + ' / ' + track.allTerms.length + ' terms';
      statusEl.className = 'track-status';
    }
  });

  card.querySelector('.sel-mode').addEventListener('change', e => {
    track.mappingMode = e.target.value;
    card.querySelector('.root-group').classList.toggle('hidden', track.mappingMode !== 'diatonic');
  });

  selRoot.addEventListener('change', e => {
    track.rootNote = parseInt(e.target.value, 10);
  });

  selScale.addEventListener('change', e => {
    track.scale = SCALES[e.target.value] || SCALES.major;
  });

  card.querySelector('.sel-wave').addEventListener('change', e => {
    track.waveform = e.target.value;
  });

  card.querySelector('.inp-vol').addEventListener('input', e => {
    track.volume = parseFloat(e.target.value);
    syncTrackGain(track);
  });

  card.querySelector('.btn-mute').addEventListener('click', () => toggleMute(track, card));
  card.querySelector('.btn-delete').addEventListener('click', () => deleteTrack(track, card));

  document.getElementById('track-list').appendChild(card);
  return card;
}

async function handleFetch(track, card) {
  const id = card.querySelector('.inp-oeis-id').value.trim().toUpperCase();
  if (!id) return;
  const statusEl = card.querySelector('.track-status');
  statusEl.textContent = 'Fetching...';
  statusEl.className = 'track-status';
  try {
    const result = await fetchOEIS(id);
    track.oeisId   = id;
    track.allTerms = result.terms;
    track.name     = result.name;
    track.noteIndex = 0;
    card.querySelector('.track-title').textContent = id + ': ' + result.name;

    const limitInput = card.querySelector('.inp-term-limit');
    const existingVal = parseInt(limitInput.value, 10);
    if (isNaN(existingVal) || existingVal < 1) {
      limitInput.value = result.terms.length;
      track.termLimit = result.terms.length;
    } else {
      track.termLimit = Math.min(existingVal, result.terms.length);
      limitInput.value = track.termLimit;
    }

    applyTermLimit(track, card);
    statusEl.textContent = track.terms.length + ' terms loaded';
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.add('error');
  }
}

function toggleMute(track, card) {
  track.muted = !track.muted;
  card.querySelector('.btn-mute').textContent = track.muted ? 'Unmute' : 'Mute';
  card.classList.toggle('muted', track.muted);
  syncTrackGain(track);
}

function deleteTrack(track, card) {
  AppState.tracks = AppState.tracks.filter(t => t.id !== track.id);
  if (track.gainNode) track.gainNode.disconnect();
  card.remove();
}

// --- Bootstrap ---

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-play').addEventListener('click', () => {
    if (AppState.isPlaying) stop(); else play();
  });
  document.getElementById('btn-stop').addEventListener('click', stop);

  document.getElementById('chk-loop').addEventListener('change', e => {
    AppState.loop = e.target.checked;
  });

  document.getElementById('inp-bpm').addEventListener('input', e => {
    AppState.bpm = clamp(parseInt(e.target.value, 10) || 120, 20, 300);
  });

  document.getElementById('btn-export-wav').addEventListener('click', () => {
    exportWAV(parseInt(document.getElementById('inp-export-bars').value, 10) || 8);
  });

  document.getElementById('btn-add-track').addEventListener('click', createTrack);

  const aboutPanel = document.getElementById('about-panel');
  document.getElementById('btn-about').addEventListener('click', () => {
    aboutPanel.classList.toggle('hidden');
  });
  document.getElementById('btn-about-close').addEventListener('click', () => {
    aboutPanel.classList.add('hidden');
  });

  updateTransportUI();
  const firstTrack = createTrack();
  // Pre-populate so the user can click Fetch immediately without typing
  const firstCard = document.querySelector('.track-card');
  if (firstCard) firstCard.querySelector('.inp-oeis-id').value = 'A000045';
});
