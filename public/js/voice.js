// Hands-free voice commands ("camera", "live", "report", "history", "start ride"…).
// Uses the browser's speech recognition: Chrome on Android, and Safari on iPhone (Siri
// dictation must be on: Settings → General → Keyboard → Enable Dictation). Recognition
// stops by itself after silence or a few minutes, so the listener restarts it.

// Spoken phrase → command. Order matters: longer, more specific phrases first.
const COMMANDS = [
  ['start ride', /\b(start|begin)( the)? (ride|riding|recording)\b/],
  ['stop ride', /\b(stop|end|finish)( the)? (ride|riding|recording)\b/],
  ['exit full screen', /\b(exit|close|leave)( the)? (full ?screen|camera view)\b/],
  ['full screen', /\b(full ?screen|camera view|show camera|open camera)\b/],
  ['dashcam off', /\bdash ?cam(era)? off\b|\bstop( the)? dash ?cam/],
  ['dashcam on', /\bdash ?cam(era)? on\b|\bstart( the)? dash ?cam/],
  ['camera off', /\b(camera|cam) off\b|\bstop( the)? camera\b/],
  ['camera on', /\b(camera|cam) on\b|\bstart( the)? camera\b/],
  ['view:camera', /\b(dash ?cam(era)?|camera|recordings?|videos?|clips?)\b/],
  ['view:report', /\b(reports?|summary|analysis)\b/],
  ['view:history', /\b(history|rides|past rides|hazards?)\b/],
  ['view:setup', /\b(setup|set up|settings)\b/],
  ['view:live', /\b(live|dashboard|cockpit|home|speed)\b/],
];

// Optional wake word: with requireWake, only phrases containing "ride lens"/"ridelens" count,
// so talk with a pillion or a phone call doesn't switch screens.
export function parseCommand(transcript, { requireWake = false } = {}) {
  let t = String(transcript || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const wake = /\b(ride ?lens|ride lands|right lens)\b/;
  if (requireWake) { if (!wake.test(t)) return null; t = t.replace(wake, ' ').trim(); }
  for (const [cmd, re] of COMMANDS) if (re.test(t)) return cmd;
  return null;
}

export const voiceSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// Starts listening; returns stop(). onCommand(cmd, transcript); onState({listening, error})
export function startVoice({ onCommand, onState, requireWake = false, lang = 'en-IN' }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { onState?.({ listening: false, error: 'Voice commands are not available in this browser' }); return () => {}; }
  let stopped = false, rec = null, last = { cmd: null, t: 0 }, fails = 0;
  const begin = () => {
    if (stopped || document.hidden) { rec = null; return; }
    rec = new SR();
    rec.lang = lang; rec.continuous = true; rec.interimResults = false; rec.maxAlternatives = 3;
    rec.onstart = () => { fails = 0; onState?.({ listening: true }); };
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        for (const alt of e.results[i]) {
          const cmd = parseCommand(alt.transcript, { requireWake });
          if (!cmd) continue;
          if (cmd === last.cmd && Date.now() - last.t < 2500) break; // same phrase reported twice
          last = { cmd, t: Date.now() };
          onCommand(cmd, alt.transcript);
          break;
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { stopped = true; onState?.({ listening: false, error: 'Microphone or speech recognition permission was refused' }); }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') fails++;
    };
    rec.onend = () => {
      onState?.({ listening: false });
      if (!stopped) setTimeout(begin, Math.min(10000, 300 * 2 ** fails)); // keep listening; back off on repeated errors
    };
    try { rec.start(); } catch { setTimeout(begin, 1000); }
  };
  const onVis = () => { if (!document.hidden && !stopped && !rec) begin(); };
  document.addEventListener('visibilitychange', onVis);
  begin();
  return () => { stopped = true; document.removeEventListener('visibilitychange', onVis); try { rec?.abort(); } catch {} onState?.({ listening: false }); };
}
