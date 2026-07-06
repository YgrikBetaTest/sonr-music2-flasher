# WCH USB-ISP protocol — CH32V30x (as needed for SONR Music 2)

Distilled from **wchisp** (Rust, github.com/ch32-rs/wchisp, `main`) and cross-checked
against this project's native-DLL findings (`../M2 User Updater/flasher/dll/INVESTIGATION.md`).
Everything here is what the WebUSB JS must reproduce. Values are verbatim from wchisp.

## USB transport

- Device in BOOT mode: **VID `0x4348`** (older bootloaders) or **`0x1a86`** (newer);
  **PID `0x55e0`**. SONR Music 2 enumerates as `0x4348 / 0x55e0`.
- Claim **interface 0**. Endpoints: bulk **OUT `0x02`**, bulk **IN `0x82`**.
- 64-byte transfers. Timeout ~5000 ms (300 ms is enough per program chunk).
- On **Windows** the device must be bound to **WinUSB** for `navigator.usb` to claim it
  (production driver is WCH CH375 → needs a one-time WinUSB install via `Setup-This-PC.cmd`).
  See `../SETUP_WINUSB.md`.

## Packet framing

Request:  `[cmd:1][len:u16 LE][payload:len ...]`  (len counts only the payload)
Response: `[cmd_echo:1][status:1][len:u16 LE][payload:len ...]`  (payload = raw[4 .. 4+len])
`status`/`payload[0]` == `0x00` means success for most commands.

## Command opcodes (`constants::commands`)

| name          | byte  |
|---------------|-------|
| IDENTIFY      | 0xa1  |
| ISP_END       | 0xa2  |
| ISP_KEY       | 0xa3  |
| ERASE         | 0xa4  |
| PROGRAM       | 0xa5  |
| VERIFY        | 0xa6  |
| READ_CONFIG   | 0xa7  |
| WRITE_CONFIG  | 0xa8  |
| DATA_ERASE    | 0xa9  |
| DATA_PROGRAM  | 0xaa  |
| DATA_READ     | 0xab  |
| WRITE_OTP     | 0xc3  |
| READ_OTP      | 0xc4  |
| SET_BAUD      | 0xc5  |

Config bit-masks: `RDPR_USER_DATA_WPR = 0x07`, `BTVER = 0x08`, `UID = 0x10`, `ALL = 0x1f`.

## Exact packet layouts (from wchisp `Command::into_raw`)

- **IDENTIFY(device_id, device_type):**
  `a1 12 00 [device_id] [device_type] "MCU ISP & WCH.CN"` (16 ASCII bytes). len = 0x12 = 18.
  Initial call uses `identify(0, 0)`; response `payload = [chip_id, device_type]`.
  For SONR: chip_id **0x33**, device_type **0x17**.

- **ISP_KEY(key):** `a3 [len] 00 [key ...]`. Flow sends `isp_key([0;0x1e])` (30 zero bytes).
  Response `payload[0]` must equal the locally computed key checksum (see XOR key).

- **ERASE(sectors:u32):** `a4 04 00 [sectors LE32]`.
  `sectors = ceil-ish = floor(fwlen/1024) + 1`, clamped to **min 8** (CH32V30x).

- **PROGRAM(address:u32, padding:u8, data):**
  `a5 [size LE16] [address LE32] [padding:1] [data ...]` where `size = 4 + 1 + data.len`.
  Note **address LE32 starts at byte offset 3**, padding at byte 7, data at byte 8.

- **VERIFY(...):** identical layout to PROGRAM but opcode `a6`.

- **READ_CONFIG(bit_mask):** `a7 02 00 [bit_mask] 00`.
  Response payload = `[bit_mask, 00, <config bytes...>]`; the 12 RDPR/USER/DATA/WPR bytes
  live at `payload[2..14]`.

- **WRITE_CONFIG(bit_mask, data):**
  `a8 [2+len LE16] 00 [bit_mask] 00 [data ...]` — i.e. buf[3]=bit_mask, buf[4]=0, data at buf[5].

- **ISP_END(reason:u8):** `a2 01 00 [reason]`. `reason = 1` → reset & run user code.

## XOR key derivation (critical — from wchisp)

```
checksum = sum_mod256( chip_uid[0..8] )          // 8-byte UID, u8 overflowing add
key      = [checksum; 8]
key[7]   = key[7] + chip_id (mod 256)            // chip_id = 0x33 for CH32V303CBT
key_checksum = sum_mod256( key[0..8] )           // compare against isp_key response payload[0]
```

`chip_uid` comes from READ_CONFIG with `UID` mask (`0x10`) — 8 bytes.
Program/Verify **data is XORed**: `out[i] = data[i] ^ key[i % 8]`. `padding` is a random byte.

## Flash flow (order matters) — ✅ verified on hardware

Two hard-won facts drive this whole flow (both cost real hardware iterations):

> **1. Deprotect arms a deferred mass-erase.** On CH32V, writing RDPR from a protected value to
> `0xA5` **arms a flash mass-erase that only completes on the NEXT reset.** So you MUST reset
> *between* deprotect and programming — otherwise the final reset erases the firmware you just
> wrote (verify passes at verify time, but the board boots empty and stays dead: the classic
> "programs+verifies but won't run" bug). Deprotect is its own step, ending with a reset.

> **2. The reset target comes from the PRECEDING command, not from `ISP_END`.** `ISP_END(0xa2)`'s
> reason byte is only "reset / don't reset". Whether the reset lands in the **bootloader** or in
> **user code** is set by the last command: after `PROGRAM(0xa5)` → user code; after
> `WRITE_CONFIG(0xa8)` → bootloader. So `WRITE_CONFIG` must be the command **immediately before**
> `ISP_END(1)` (nothing in between) for the chip to come back in BOOT. (Source: basilhussain
> ch32v003-bootloader-docs.) Even so, on this board a **physical "+" (BOOT) press** is what
> actually re-enters BOOT after the deprotect reset — see below.

The full flow (single WebUSB session end-to-end, thanks to the permission policy):

1. `IDENTIFY(0,0)` → chip_id 0x33, device_type 0x17.
2. `READ_CONFIG(ALL=0x1f)` → bootloader ver, protection state, **UID** (for the XOR key).
3. `READ_CONFIG(0x07)` → 12 option bytes; if `RDPR != 0xA5` (factory/used board), **deprotect:**
   set `cfg[0]=0xA5, cfg[1]=0x5A`, `cfg[8..12]=0xFF` (WPR off), preserve `cfg[2..8]`;
   `WRITE_CONFIG(0x07, cfg)` **immediately** followed by `ISP_END(1)`. The chip mass-erases and
   drops off USB. **STOP** and wait for it to come back.
4. **Re-acquire the board** (the operator gives a single **"+" tap**, which re-enters BOOT): poll
   `navigator.usb.getDevices()` until the `0x4348/0x55E0` device reappears, then `open()` it and
   re-run `IDENTIFY` + `READ_CONFIG`. No picker, no gesture — see the policy note below.
5. `ISP_KEY([0;0x1e])` → validate checksum. `ERASE(sectors)`.
6. Program loop: 56-byte chunks, `PROGRAM(addr, rand, xored)`, addr += chunk.len; finish with an
   **empty** `PROGRAM(addr, rand, [])`.
7. Verify loop: same chunking with `VERIFY`; each response `payload[0]` must be 0.
8. `ISP_END(1)` → reset & run. No RDPR transition here → no deferred erase → firmware **runs
   immediately** (LED blinks; no power-cycle). The SONR firmware **re-enables read-protect itself**
   on boot, so a used board reads `RDPR != 0xA5` again next time (always takes the deprotect path).

An already-deprotected device (`RDPR=0xA5`) skips step 3/4 — straight to erase/program.

> **The permission policy is what makes step 4 automatic.** WebUSB keys permission on
> `(origin, VID, PID, serialNumber)`. The WCH bootloader has **no serial number**, so on
> disconnect Chrome **revokes** the grant → after the deprotect re-enumeration `getDevices()`
> returns 0 and you'd need a fresh `requestDevice()` picker. The **`WebUsbAllowDevicesForUrls`**
> enterprise policy (VID/PID-scoped, one-time per-PC registry entry — see `enable-webusb-auto.reg`
> / `SETUP_WINUSB.md`) grants standing permission with no serial needed, so `getDevices()` returns
> the re-enumerated board and step 4 reconnects silently. Without the policy this flow needs a
> second device-picker pop-up.

### Option / firmware notes (SONR specifics, confirmed on hardware)
- Raw read of the option bytes (`READ_CONFIG(0x07)`), register bytes in memory order:
  RDPR_USER = `FF 00 9F 60` (RDPR=0xFF protected, nRDPR=0x00, USER=0x9F, nUSER=0x60),
  DATA = `FF 00 FF 00`, WPR = `FF FF FF FF`. (The vendor DLL prints these byte-reversed, e.g.
  "FF009F60" — same bytes, opposite display order. Raw read/write is self-consistent.)
- **USER=0x9F is preserved through deprotect and is not the boot factor** — leaving the device
  **unprotected** (RDPR=0xA5) after flashing boots and runs fine. Re-enabling read-protect (write a
  non-0xA5 RDPR before reset) is optional hardening; *enabling* protection does NOT erase (only
  *disabling* does), so it's safe to add later.
- **Zero-pad the image to the next 4 KB** before programming to match the vendor byte-for-byte
  (`119568 → 122880`). Not proven strictly required in the raw path, but costs nothing and removes
  a variable.

## References
- wchisp: https://github.com/ch32-rs/wchisp  (`src/{protocol,flashing,device,constants}.rs`, `devices/0x17-CH32V30x.yaml`)
- WebUSB: https://developer.mozilla.org/docs/Web/API/USB
