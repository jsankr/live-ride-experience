// ELM327 OBD-II driver with two transports:
//   * Bluetooth Low Energy  -> Web Bluetooth (Chrome/Edge on Android, desktop Chrome)
//   * Wi-Fi ELM327 (TCP)    -> browsers cannot open raw TCP sockets, so we go through
//                              the WebSocket bridge in server/server.mjs (/obd)
// Classic-Bluetooth (SPP) ELM327 dongles are NOT reachable from a browser at all.

// Mode 01 PIDs we care about. Bikes usually support only a subset; we probe 0100/0120/0140.
export const PIDS = {
  '04': { key: 'load', bytes: 1, f: (a) => (a * 100) / 255, slow: true },
  '05': { key: 'coolant', bytes: 1, f: (a) => a - 40, slow: true },
  '0B': { key: 'map', bytes: 1, f: (a) => a, slow: true },
  '0C': { key: 'rpm', bytes: 2, f: (a, b) => (a * 256 + b) / 4 },
  '0D': { key: 'speed', bytes: 1, f: (a) => a },
  '0F': { key: 'intake', bytes: 1, f: (a) => a - 40, slow: true },
  '11': { key: 'throttle', bytes: 1, f: (a) => (a * 100) / 255 },
  '42': { key: 'voltage', bytes: 2, f: (a, b) => (a * 256 + b) / 1000, slow: true },
  '46': { key: 'ambient', bytes: 1, f: (a) => a - 40, slow: true },
  '5C': { key: 'oil', bytes: 1, f: (a) => a - 40, slow: true },
};

// Parse a raw ELM327 reply for a mode-01 request. Handles echo, spaces, headers
// off, multi-ECU replies and "NO DATA". Returns the decoded value or null.
export function parsePid(pid, raw) {
  const def = PIDS[pid];
  if (!def || !raw) return null;
  const lines = raw.replace(/>/g, '').split(/[\r\n]+/).map((l) => l.replace(/\s+/g, '').toUpperCase()).filter(Boolean);
  for (const l of lines) {
    const i = l.indexOf('41' + pid);
    if (i < 0) continue;
    const hex = l.slice(i + 4, i + 4 + def.bytes * 2);
    if (hex.length < def.bytes * 2 || /[^0-9A-F]/.test(hex)) continue;
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    return def.f(...bytes);
  }
  return null;
}

// Decode a 0100/0120/0140 "supported PIDs" bitmap into a Set of 2-char PIDs.
export function parseSupported(base, raw) {
  const out = new Set();
  const lines = (raw || '').split(/[\r\n]+/).map((l) => l.replace(/\s+/g, '').toUpperCase());
  for (const l of lines) {
    const i = l.indexOf('41' + base);
    if (i < 0) continue;
    const hex = l.slice(i + 4, i + 12);
    if (hex.length < 8) continue;
    const bits = parseInt(hex, 16) >>> 0;
    for (let b = 0; b < 32; b++) {
      if (bits & (1 << (31 - b))) out.add((parseInt(base, 16) + b + 1).toString(16).toUpperCase().padStart(2, '0'));
    }
  }
  return out;
}

// ---------- transports ----------
// Known BLE UART services used by ELM327 clones (Vgate iCar, Veepeak, OBDLink CX, generic)
export const BLE_SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 0xae00,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
];

export async function bleTransport() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available. Use Chrome on Android (not iOS) over HTTPS.');
  const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  const server = await device.gatt.connect();
  let writeChar = null, notifyChar = null;
  for (const svc of await server.getPrimaryServices()) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch { continue; }
    for (const c of chars) {
      if (!notifyChar && (c.properties.notify || c.properties.indicate)) notifyChar = c;
      if (!writeChar && (c.properties.write || c.properties.writeWithoutResponse)) writeChar = c;
    }
    if (writeChar && notifyChar) break;
  }
  if (!writeChar || !notifyChar) throw new Error('No UART-style characteristics found on this adapter.');
  const listeners = new Set();
  const dec = new TextDecoder();
  notifyChar.addEventListener('characteristicvaluechanged', (e) => {
    const s = dec.decode(e.target.value);
    listeners.forEach((fn) => fn(s));
  });
  await notifyChar.startNotifications();
  const enc = new TextEncoder();
  return {
    name: device.name || 'BLE OBD',
    async write(str) {
      const data = enc.encode(str);
      for (let i = 0; i < data.length; i += 20) { // stay under default MTU
        const chunk = data.slice(i, i + 20);
        if (writeChar.properties.writeWithoutResponse) await writeChar.writeValueWithoutResponse(chunk);
        else await writeChar.writeValue(chunk);
      }
    },
    onData(fn) { listeners.add(fn); },
    close() { try { device.gatt.disconnect(); } catch {} },
    onClose(fn) { device.addEventListener('gattserverdisconnected', fn); },
  };
}

export function wsTransport(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const listeners = new Set();
    const closers = new Set();
    ws.onmessage = (e) => listeners.forEach((fn) => fn(String(e.data)));
    ws.onclose = () => closers.forEach((fn) => fn());
    ws.onerror = () => reject(new Error(`Could not reach the Wi-Fi OBD bridge at ${url}`));
    ws.onopen = () => resolve({
      name: 'Wi-Fi OBD',
      async write(str) { ws.send(str); },
      onData(fn) { listeners.add(fn); },
      close() { ws.close(); },
      onClose(fn) { closers.add(fn); },
    });
  });
}

// ---------- ELM327 session ----------
export class Elm327 {
  constructor(transport, { protocol = '0', log = () => {} } = {}) {
    this.tx = transport; this.protocol = protocol; this.log = log;
    this.buf = ''; this.waiter = null; this.supported = new Set(); this.running = false;
    transport.onData((s) => {
      this.buf += s;
      if (this.buf.includes('>') && this.waiter) {
        const out = this.buf; this.buf = '';
        const w = this.waiter; this.waiter = null; w.resolve(out);
      }
    });
  }

  send(cmd, timeout = 2500) {
    return new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => { this.waiter = null; reject(new Error(`timeout: ${cmd}`)); }, timeout);
      this.waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); } };
      this.tx.write(cmd + '\r').catch(reject);
    });
  }

  async init() {
    const steps = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT2', `ATSP${this.protocol}`];
    for (const c of steps) {
      try { const r = await this.send(c, c === 'ATZ' ? 4000 : 2500); this.log(`${c} -> ${r.trim()}`); }
      catch (e) { this.log(`${c} failed: ${e.message}`); }
    }
    // the first 0100 on auto-protocol can take several seconds (protocol search)
    for (const base of ['00', '20', '40']) {
      try {
        const r = await this.send('01' + base, 9000);
        this.log(`01${base} -> ${r.trim()}`);
        parseSupported(base, r).forEach((p) => this.supported.add(p));
        if (!this.supported.has((parseInt(base, 16) + 0x20).toString(16).toUpperCase().padStart(2, '0'))) break;
      } catch (e) { this.log(`01${base} failed: ${e.message}`); break; }
    }
    if (!this.supported.size) this.log('ECU did not report supported PIDs - polling the common set anyway');
    return this.supported;
  }

  pidList() {
    const want = Object.keys(PIDS);
    return this.supported.size ? want.filter((p) => this.supported.has(p)) : ['0C', '0D', '05', '11'];
  }

  // Fast PIDs (rpm, speed, throttle) every cycle; slow ones round-robin.
  async start(onData) {
    this.running = true;
    const list = this.pidList();
    const fast = list.filter((p) => !PIDS[p].slow);
    const slow = list.filter((p) => PIDS[p].slow);
    let si = 0, misses = 0;
    while (this.running) {
      const batch = [...fast];
      if (slow.length) batch.push(slow[si++ % slow.length]);
      const data = {};
      for (const pid of batch) {
        if (!this.running) break;
        try {
          const r = await this.send('01' + pid, 1500);
          const v = parsePid(pid, r);
          if (v != null) { data[PIDS[pid].key] = v; misses = 0; } else misses++;
        } catch { misses++; }
      }
      if (Object.keys(data).length) onData(Date.now(), data);
      if (misses > 20) { this.log('ECU stopped answering (ignition off?)'); misses = 0; await new Promise((r) => setTimeout(r, 1000)); }
    }
  }

  stop() { this.running = false; }
  close() { this.stop(); this.tx.close(); }
}
