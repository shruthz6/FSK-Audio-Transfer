# FSK Audio File Transfer

An application that transmits small binary files as audio over acoustic signals using Frequency Shift Keying (FSK), and decodes the audio back into original downloadable files.

> **Status:** Web Implementation is **Phase 1 and Phase 2 Complete** (strictly adhering to `SPEC.md`).

---

## Protocol Specification Overview (`SPEC.md`)

- **Space Frequency (Bit 0):** 1900 Hz
- **Mark Frequency (Bit 1):** 2300 Hz
- **Baud Rate:** 50 baud (50 bits/sec, 20 ms / bit)
- **Sample Rate:** 44100 Hz (882 samples / bit)
- **Amplitude Scaling:** 75% (`0.75`) to prevent audio clipping
- **Preamble:** 1.0s alternating tone burst (1900 Hz / 2300 Hz, threshold: 48 windows)
- **Post-Preamble Guard:** 100 ms silence
- **Bit Framing:** `[Start Bit = 0]` `[8 Data Bits MSB-first]` `[Stop Bit = 1]`
- **Postamble:** 3 tones at 2700 Hz (300 ms each)
- **Guard Silences:** 300 ms before preamble, 300 ms after postamble
- **Packet Format:** `[Header] [Payload Bytes] [CRC-8 Checksum]`
  - Header: `[Filename Length (1 B)]` `[Filename (UTF-8)]` `[File Size (4 B Big-Endian)]` `[File Type (8 B padded)]`
  - Payload: Raw binary payload (`Uint8Array`)
  - Checksum: CRC-8 polynomial `0x07` calculated over payload bytes (Test Vector: `CRC8("123456789") = 0xF4`)

---

## Directory Structure

```text
├── SPEC.md             # Authoritative Protocol Specification
├── web/
│   ├── send.html       # Web Sender Application (File selection, FSK encoding, Web Audio play)
│   ├── receive.html    # Web Receiver Application (Mic input, Goertzel demodulation, CRC check, File reconstruction)
│   ├── diagnostic.html # In-Memory Software Loopback Diagnostic (Text & raw binary test)
│   ├── style.css       # Shared visual styles
│   ├── encoder/
│   │   ├── encoder.js  # FSK Modulation, packet building, framing, CRC-8
│   │   └── index.html  # Standalone Encoder test page
│   ├── decoder/
│   │   ├── decoder.js  # Goertzel demodulation, bit framing, packet parsing, self-test
│   │   └── index.html  # Standalone Decoder test page
│   └── shared/
│       └── fsk-helpers.js # FSK Audio helper bridges
├── android/            # (Phase 3 - Mobile Android app placeholder)
└── ios/                # (Phase 3 - Mobile iOS app placeholder)
```

---

## How to Run & Test (Web)

Since this web app relies on standard Web APIs (`Web Audio API`, `navigator.mediaDevices.getUserMedia`), open the files using any modern web browser (Chrome, Edge, Firefox, Safari) via a local HTTP server (or file URL if media permissions allow).

### 1. Sender (`web/send.html`)
1. Open `web/send.html`.
2. Drag & drop or select any small file (`.png`, `.pdf`, `.txt`, `.bin`, etc.).
3. Click **Play / Send**. The app converts the file into FSK audio signal and plays it out loud.

### 2. Receiver (`web/receive.html`)
1. Open `web/receive.html` on the receiving device.
2. Click **🎙️ Start Listening** (grant microphone permission if prompted).
3. Play the audio from the Sender.
4. Upon preamble detection and decoding:
   - If CRC passes: The app displays file details and provides a **⬇ Download decoded file** button.
   - If CRC fails: Displays `"Transfer failed — data corrupted, please try again"` and suppresses download.
   - If no audio is received after 15 seconds: Displays `"No signal detected."`.

### 3. Loopback Diagnostic (`web/diagnostic.html`)
Open `web/diagnostic.html` and click **Run Software Loopback Test**.
This encodes and decodes sample text and binary payloads entirely in memory to verify 100% protocol compliance and byte-for-byte equality without requiring a speaker/mic.

### 4. Integrated Self-Test
On `web/receive.html` or `web/decoder/index.html`, click **🧪 Self-Test** to verify:
1. Standard CRC-8 test vector (`CRC8("123456789") === 0xF4`).
2. UTF-8 filename decoding and raw binary payload preservation.
3. Checksum failure rejection.

---

## Phase Completion Checklist

- [x] **Phase 1:** 50 baud FSK modulation & demodulation, bit framing (start 0, 8 data MSB, stop 1), 1s alternating preamble with 48-window threshold, 100ms gap, 2700 Hz postamble.
- [x] **Phase 2:** CRC-8 checksum calculation over payload, file header encoding/parsing, binary-safe `Uint8Array` file reconstruction, UTF-8 metadata support, UI corruption rejection, no-signal timeout, raw file download.

---

## Known Limitations

- **Acoustic Clock Drift on Large Files:** Over long transmissions (> 1–2 KB), acoustic clock drift between un-synchronized speaker and microphone hardware can cause bit shifts. Checksum validation ensures corrupted transfers are detected and rejected. Short files transfers (< 500 bytes) complete reliably over open air.

