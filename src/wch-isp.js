// wch-isp.js — WCH USB-ISP protocol over WebUSB for CH32V30x (SONR Music 2).
// Ported from wchisp (github.com/ch32-rs/wchisp). See ../reference/PROTOCOL.md.
//
// Usage:
//   const isp = new WchIsp({ log: msg => ... , progress: (phase, done, total) => ... });
//   await isp.connect();                 // triggers navigator.usb.requestDevice (needs a user gesture)
//   const info = await isp.identify();    // { chipId, deviceType, name, flashSize }
//   await isp.flash(firmwareUint8Array);  // full deprotect->erase->program->verify->reset
//   await isp.close();

const USB_FILTERS = [
  { vendorId: 0x4348, productId: 0x55e0 },
  { vendorId: 0x1a86, productId: 0x55e0 },
];
// WebUSB transferIn/transferOut take the endpoint NUMBER (1..15), not the address.
// Device endpoints: bulk OUT addr 0x02, bulk IN addr 0x82 -> both endpoint number 2.
const EP_OUT = 0x02 & 0x0f;  // = 2
const EP_IN = 0x82 & 0x0f;   // = 2
const IFACE = 0;

const CMD = {
  IDENTIFY: 0xa1, ISP_END: 0xa2, ISP_KEY: 0xa3, ERASE: 0xa4,
  PROGRAM: 0xa5, VERIFY: 0xa6, READ_CONFIG: 0xa7, WRITE_CONFIG: 0xa8,
};
const CFG_MASK = { RDPR_USER_DATA_WPR: 0x07, BTVER: 0x08, UID: 0x10, ALL: 0x1f };

const SECTOR_SIZE = 1024;   // bytes per sector for the erase-count calc (wchisp)
const MIN_SECTORS = 8;      // CH32V30x (device_type != 0x10)
const CHUNK = 56;           // program/verify payload chunk size (wchisp)

// Minimal CH32V30x variant table (devices/0x17-CH32V30x.yaml). flash in bytes.
const CH32V30X = {
  deviceType: 0x17,
  variants: {
    0x50: { name: 'CH32V305RBT6', flash: 128 * 1024 },
    0x70: { name: 'CH32V307VCT6', flash: 256 * 1024 },
    0x71: { name: 'CH32V307RCT6', flash: 256 * 1024 },
    0x73: { name: 'CH32V307WCU6', flash: 256 * 1024 },
    0x30: { name: 'CH32V303VCT6', flash: 256 * 1024 },
    0x31: { name: 'CH32V303RCT6', flash: 256 * 1024 },
    0x32: { name: 'CH32V303RBT6', flash: 128 * 1024 },
    0x33: { name: 'CH32V303CBT6', flash: 128 * 1024 },  // <- SONR Music 2
  },
};

const IDENTIFY_TAIL = new TextEncoder().encode('MCU ISP & WCH.CN');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum8 = (arr) => arr.reduce((a, x) => (a + x) & 0xff, 0);
const hex = (n, w = 2) => n.toString(16).padStart(w, '0');

export class WchIsp {
  constructor({ log = () => {}, progress = () => {} } = {}) {
    this.log = log;
    this.progress = progress;
    this.device = null;
    this.chipId = 0;
    this.deviceType = 0;
    this.chip = null;      // { name, flash }
    this.uid = null;       // Uint8Array(8)
    this.bootVer = null;
    // Whether the browser has STANDING permission (WebUsbAllowDevicesForUrls policy or a prior
    // grant) so getDevices() can re-find the board after the mid-flash reset. Set by the UI from
    // probeGranted(). When false (typical macOS/Linux without the policy), skip the futile
    // ~20 s reconnect poll and go straight to the two-pass "press Update again" fallback.
    this.autoReconnect = true;
  }

  // ---- USB plumbing -------------------------------------------------------

  async connect() {
    if (!('usb' in navigator)) {
      throw new Error('WebUSB is not supported in this browser. Use Chrome or Edge.');
    }
    // Prefer an already-granted device (via the WebUsbAllowDevicesForUrls policy or a prior
    // grant): getDevices() needs no picker and no user gesture. Fall back to the picker.
    if (await this._useGrantedDevice()) {
      await this.open();
      this.log('Device found without a pop-up (standing permission).');
      return this.deviceLabel();
    }
    this.device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    await this.open();
    return this.deviceLabel();
  }

  // True if a BOOT device is already granted (policy/prior grant) → connect() won't show a picker.
  async probeGranted() {
    try {
      const devs = await navigator.usb.getDevices();
      return devs.some((d) => USB_FILTERS.some((f) => d.vendorId === f.vendorId && d.productId === f.productId));
    } catch (_) { return false; }
  }

  // Grab an already-granted BOOT device (no picker) if one is present. Returns true on success.
  async _useGrantedDevice() {
    try {
      const devs = await navigator.usb.getDevices();
      const dev = devs.find((d) =>
        USB_FILTERS.some((f) => d.vendorId === f.vendorId && d.productId === f.productId));
      if (dev) { this.device = dev; return true; }
    } catch (_) {}
    return false;
  }

  async open() {
    const d = this.device;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    // Some enumerations need the interface explicitly; ignore "already claimed".
    try { await d.claimInterface(IFACE); }
    catch (e) { this.log('claimInterface: ' + e.message); throw e; }
  }

  deviceLabel() {
    const d = this.device;
    return `${d.productName || 'WCH device'} (VID ${hex(d.vendorId, 4)} / PID ${hex(d.productId, 4)})`;
  }

  async close() {
    if (!this.device) return;
    try { await this.device.releaseInterface(IFACE); } catch (_) {}
    try { await this.device.close(); } catch (_) {}
    this.device = null;
  }

  async _send(bytes) {
    const res = await this.device.transferOut(EP_OUT, bytes);
    if (res.status !== 'ok') throw new Error('USB transferOut: ' + res.status);
  }

  async _recv() {
    const res = await this.device.transferIn(EP_IN, 64);
    if (res.status !== 'ok') throw new Error('USB transferIn: ' + res.status);
    return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  }

  // Send a framed command, read the response, return { cmd, status, payload }.
  async _xfer(bytes) {
    await this._send(bytes);
    const raw = await this._recv();
    if (raw.length < 4) throw new Error('Short USB response (' + raw.length + ' bytes)');
    const len = raw[2] | (raw[3] << 8);
    const payload = raw.slice(4, 4 + len);
    return { cmd: raw[0], status: raw[1], payload };
  }

  // ---- command builders ---------------------------------------------------

  _frameProgramLike(op, address, padding, data) {
    const buf = new Uint8Array(1 + 2 + 4 + 1 + data.length);
    buf[0] = op;
    const size = 4 + 1 + data.length;          // payload size
    buf[1] = size & 0xff; buf[2] = (size >> 8) & 0xff;
    buf[3] = address & 0xff; buf[4] = (address >> 8) & 0xff;
    buf[5] = (address >> 16) & 0xff; buf[6] = (address >> 24) & 0xff;
    buf[7] = padding;
    buf.set(data, 8);
    return buf;
  }

  // ---- high-level operations ---------------------------------------------

  async identify() {
    const buf = new Uint8Array(3 + 18);
    buf[0] = CMD.IDENTIFY; buf[1] = 0x12; buf[2] = 0x00;
    buf[3] = 0x00; buf[4] = 0x00;               // identify(0,0)
    buf.set(IDENTIFY_TAIL, 5);
    const r = await this._xfer(buf);
    this.chipId = r.payload[0];
    this.deviceType = r.payload[1];
    if (this.deviceType !== CH32V30X.deviceType) {
      throw new Error(`Unexpected device_type 0x${hex(this.deviceType)} ` +
        `(expected 0x17 CH32V30x). chip_id=0x${hex(this.chipId)}`);
    }
    this.chip = CH32V30X.variants[this.chipId] ||
      { name: `CH32V30x(0x${hex(this.chipId)})`, flash: 128 * 1024 };
    this.log(`Chip: ${this.chip.name} (chip_id 0x${hex(this.chipId)}, type 0x${hex(this.deviceType)})`);
    return { chipId: this.chipId, deviceType: this.deviceType, name: this.chip.name, flashSize: this.chip.flash };
  }

  async _readConfig(mask) {
    const r = await this._xfer(new Uint8Array([CMD.READ_CONFIG, 0x02, 0x00, mask, 0x00]));
    return r.payload; // [mask, 0x00, <config bytes...>]
  }

  async readConfigAll() {
    const p = await this._readConfig(CFG_MASK.ALL);
    // payload = [mask, 00, RDPR_USER(4), DATA(4), WPR(4), BTVER(4), UID(8)] (mask-dependent)
    const cfg = p.slice(2);
    // With ALL mask wchisp returns 12 option bytes then 4 btver then 8 uid.
    this.uid = cfg.slice(12 + 4, 12 + 4 + 8);
    if (this.uid.length !== 8) {
      // Fallback: explicit UID read.
      const u = await this._readConfig(CFG_MASK.UID);
      this.uid = u.slice(2, 10);
    }
    this.bootVer = cfg.slice(12, 16);
    const rdpr = cfg[0];
    const protected_ = rdpr !== 0xa5;
    this.log(`Bootloader ${cfg[13] ?? '?'}.${cfg[12] ?? '?'} · UID ` +
      Array.from(this.uid).map((b) => hex(b)).join('') + ` · read-protect: ${protected_ ? 'ON' : 'off'}`);
    return { cfg, protected: protected_, uid: this.uid };
  }

  // Read the 12 option bytes (RDPR_USER + DATA + WPR) and log a raw hex dump.
  async readOpt() {
    const p = await this._readConfig(CFG_MASK.RDPR_USER_DATA_WPR);
    const cfg = p.slice(2, 14);
    if (cfg.length !== 12) throw new Error('read_config returned ' + cfg.length + ' bytes (expected 12)');
    this.log('Option bytes: RDPR_USER=' + this._optHex(cfg, 0) +
      ' DATA=' + this._optHex(cfg, 4) + ' WPR=' + this._optHex(cfg, 8));
    return Uint8Array.from(cfg);
  }

  _optHex(cfg, off) { // print a 4-byte register as its 32-bit value (LE)
    return '0x' + [3, 2, 1, 0].map((i) => hex(cfg[off + i])).join('');
  }

  // Write 12 option bytes verbatim via WRITE_CONFIG(RDPR_USER_DATA_WPR).
  async writeOpt(opt12, label) {
    const wc = new Uint8Array(1 + 2 + 2 + opt12.length);
    wc[0] = CMD.WRITE_CONFIG;
    const size = 2 + opt12.length;
    wc[1] = size & 0xff; wc[2] = (size >> 8) & 0xff;
    wc[3] = CFG_MASK.RDPR_USER_DATA_WPR; wc[4] = 0x00;
    wc.set(opt12, 5);
    const r = await this._xfer(wc);
    if (r.payload[0] !== 0x00 && r.status !== 0x00) {
      throw new Error('write_config (' + label + ') failed, status 0x' + hex(r.status));
    }
  }

  // Deprotect for erase/program: RDPR=0xA5, WPR off, preserve USER+DATA.
  async unprotect(cfg) {
    const out = Uint8Array.from(cfg);
    out[0] = 0xa5; out[1] = 0x5a;               // RDPR = unprotected
    out[8] = 0xff; out[9] = 0xff; out[10] = 0xff; out[11] = 0xff; // WPR off
    await this.writeOpt(out, 'unprotect');
    this.log('Read-protect removed (RDPR=0xA5) for erase/write.');
  }

  _xorKey() {
    if (!this.uid) throw new Error('UID not read (call readConfigAll before the key)');
    const checksum = sum8(this.uid);
    const key = new Uint8Array(8).fill(checksum);
    key[7] = (key[7] + this.chipId) & 0xff;
    return key;
  }

  async ispKey() {
    const key = this._xorKey();
    const expected = sum8(key);
    const buf = new Uint8Array(3 + 0x1e);
    buf[0] = CMD.ISP_KEY; buf[1] = 0x1e; buf[2] = 0x00; // 30 zero bytes payload
    const r = await this._xfer(buf);
    if (r.payload[0] !== expected) {
      throw new Error(`isp_key checksum mismatch: got 0x${hex(r.payload[0])}, want 0x${hex(expected)}`);
    }
    this._key = key;
    return key;
  }

  async erase(fwLen) {
    let sectors = Math.floor(fwLen / SECTOR_SIZE) + 1;
    if (sectors < MIN_SECTORS) sectors = MIN_SECTORS;
    const buf = new Uint8Array([CMD.ERASE, 0x04, 0x00,
      sectors & 0xff, (sectors >> 8) & 0xff, (sectors >> 16) & 0xff, (sectors >> 24) & 0xff]);
    const r = await this._xfer(buf);
    if (r.payload[0] !== 0x00 && r.status !== 0x00) {
      throw new Error('erase failed, status 0x' + hex(r.status));
    }
    this.log(`Erased ${sectors} sectors (${sectors} KB).`);
  }

  _rand() { return (globalThis.crypto ? crypto.getRandomValues(new Uint8Array(1))[0] : 0) & 0xff; }

  async _flashChunkLoop(op, data, key, phaseName) {
    let address = 0;
    for (let off = 0; off < data.length; off += CHUNK) {
      const chunk = data.subarray(off, Math.min(off + CHUNK, data.length));
      const xored = new Uint8Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) xored[i] = chunk[i] ^ key[i % 8];
      const r = await this._xfer(this._frameProgramLike(op, address, this._rand(), xored));
      if (r.payload[0] !== 0x00 && r.status !== 0x00) {
        throw new Error(`${phaseName} @0x${hex(address, 8)} failed, status 0x${hex(r.payload[0] || r.status)}`);
      }
      address += chunk.length;
      this.progress(phaseName, address, data.length);
    }
    // final empty chunk signals completion
    await this._xfer(this._frameProgramLike(op, address, this._rand(), new Uint8Array(0)));
    this.progress(phaseName, data.length, data.length);
  }

  async program(data) {
    const key = await this.ispKey();   // (re)sync session key before programming
    await this._flashChunkLoop(CMD.PROGRAM, data, key, 'write');
    this.log('Programming complete.');
  }

  async verify(data) {
    const key = await this.ispKey();   // wchisp re-sends isp_key before verify too
    await this._flashChunkLoop(CMD.VERIFY, data, key, 'verify');
    this.log('Verify passed.');
  }

  async _ispEnd(reason) {
    await this._xfer(new Uint8Array([CMD.ISP_END, 0x01, 0x00, reason]));
  }

  async reset() {
    await this._ispEnd(1);
    this.log('Reset & run — device restarting.');
  }

  // After the deprotect reset the chip drops off USB and — WHILE "+" IS HELD — re-enters BOOT.
  // Try to re-acquire it silently via getDevices(). Returns true on success, false on timeout
  // (then the UI falls back to a manual re-pick). Logs getDevices() so we can see whether the
  // browser keeps permission across the re-enumeration.
  async reconnectAfterReset(timeoutMs = 20000) {
    const old = this.device;
    try { await old.releaseInterface(IFACE); } catch (_) {}
    try { await old.close(); } catch (_) {}
    this.device = null;
    const attempts = Math.ceil(timeoutMs / 700);
    for (let i = 0; i < attempts; i++) {
      await sleep(700);
      let devs = [];
      try { devs = await navigator.usb.getDevices(); } catch (_) {}
      const dev = devs.find((d) => USB_FILTERS.some((f) => d.vendorId === f.vendorId && d.productId === f.productId));
      if (i % 3 === 0) this.log(`…keep holding “+” — waiting for BOOT: getDevices=${devs.length}${dev ? ' (found)' : ''}`);
      if (!dev) continue;
      try {
        this.device = dev;
        await this.open();
        this.log('Auto-reconnected to the board in BOOT — no second pick needed.');
        return true;
      } catch (_) { this.device = null; }
    }
    this.log('Auto-reconnect timed out (getDevices stayed empty) — falling back to a manual pick.');
    return false;
  }

  // Full one-shot flow. `firmware` = Uint8Array of the raw .bin.
  async flash(firmware) {
    if (!(firmware instanceof Uint8Array)) firmware = new Uint8Array(firmware);
    await this.identify();
    await this.readConfigAll();                 // reads UID (needed for XOR key)
    if (this.chipId !== 0x33) {
      this.log(`WARNING: chip_id 0x${hex(this.chipId)} != 0x33 (expected CH32V303CBT).`);
    }
    if (firmware.length > this.chip.flash) {
      throw new Error(`Firmware ${firmware.length} bytes is larger than flash ${this.chip.flash} bytes`);
    }
    const opt = await this.readOpt();           // 12 option bytes (+ hex dump)
    const wasProtected = opt[0] !== 0xa5;

    // Match the vendor DLL: program in 4 KB pages, zero-pad the final page.
    const PAGE = 4096;
    const padded = new Uint8Array(Math.ceil(firmware.length / PAGE) * PAGE);
    padded.set(firmware);
    if (padded.length !== firmware.length) {
      this.log(`Firmware zero-padded to 4 KB: ${firmware.length} -> ${padded.length} bytes.`);
    }

    if (wasProtected) {
      // Removing read-protect on CH32V ARMS a mass-erase that only completes on the NEXT reset.
      // If we program before that reset, the deferred erase wipes our firmware on the final
      // reset → device won't run. So deprotect is its own pass: deprotect → reset → STOP.
      // The chip mass-erases and re-enters BOOT with EMPTY flash on its own (no "+" needed).
      // We CANNOT auto-reconnect: after re-enumeration the browser drops USB permission (the WCH
      // bootloader has no serial number → getDevices() returns 0), so a fresh requestDevice()
      // gesture is required. The UI asks the operator to press the button again and re-pick; on
      // pass 2 the chip reads RDPR=0xA5, we skip straight to programming, and the firmware runs.
      await this.unprotect(opt);
      this.log('Deprotect done — resetting chip. KEEP HOLDING “+” so it re-enters BOOT…');
      await this._ispEnd(1);
      // Best case: the board re-enters BOOT (because "+" is held) and we grab it silently →
      // programming continues in this same call, no second click or pop-up. Only worth polling
      // when we actually hold standing permission; otherwise getDevices() can never see the
      // re-enumerated (serial-less) board, so skip straight to the two-pass fallback.
      const back = this.autoReconnect ? await this.reconnectAfterReset() : false;
      if (back) {
        await this.identify();
        await this.readConfigAll();             // refresh UID for the XOR key
        // fall through to erase/program/verify/reset below
      } else {
        // Fallback: browser dropped USB permission across the reset → a fresh pick is required.
        try { await this.close(); } catch (_) {}
        return { deprotected: true };
      }
    }

    await this.erase(padded.length);
    await this.program(padded);                 // sends isp_key internally
    await this.verify(padded);                  // sends isp_key internally
    await this.reset();                         // final reset & run (no protect transition)
    this.log('DONE ✓ — device programmed and restarted (RDPR=0xA5).');
    return { done: true };
  }
}

export { USB_FILTERS };
