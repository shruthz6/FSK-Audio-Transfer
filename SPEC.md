# FSK Audio File Transfer — Protocol Spec Sheet (v1)

This document is the "shared rulebook" all 3 apps (Web, Android, iOS) must follow exactly, so they can understand each other. Any change to these values must be updated here first and agreed on by the whole team.

---

## 1. Core Signal Parameters

| Parameter | Value | Notes |
|---|---|---|
| Space frequency (bit = 0) | **1900 Hz** | Chosen to sit above typical human voice/room-noise range |
| Mark frequency (bit = 1) | **2300 Hz** | 400 Hz gap from space frequency, for reliable detection |
| Baud rate | **50 baud** (50 bits/sec) | Start conservative; revisit in Phase 3 after reliability testing |
| Sample rate | **44100 Hz** | Standard rate, supported on all platforms by default |
| Bit duration | 1 / 50 = **20 ms per bit** | Derived from baud rate |

**Update (Phase 1 testing):** The decoder's `PREAMBLE_THRESHOLD` must be close to the *full* preamble length (~48 of 50 windows), not a short sample (15 was tried and failed) — otherwise leftover preamble tones get misread as the start of real data.

**Known limitation (deferred to Phase 2):** On longer messages, sender/receiver audio clocks drift slightly relative to each other, which can misread a run of bits mid-transmission until byte-framing resync catches back on. Short messages decode cleanly; longer ones may show partial mid-message corruption. This is what Phase 2's checksum (detect bad data) and decoder robustness work (reduce how often it happens) are for.
| Amplitude / volume | 70–80% of max device volume | Loud enough to be heard clearly, low enough to avoid distortion/clipping |

---

## 2. Preamble (Start-of-Transmission Marker)

Before any real data is sent, transmit a **1-second alternating tone burst** (rapidly switching between mark and space frequencies). This tells the receiver: *"Get ready — real data is coming next."* The receiver should continuously listen for this pattern in the background; once detected, it starts recording/decoding the following bits.

## 3. Postamble (End-of-Transmission Marker)

After all data (including the checksum, see below) has been sent, transmit a **distinct fixed tone pattern** different from both the preamble and any valid data pattern (e.g., 3 long tones at a third frequency, **2700 Hz**, held for 300ms each). This tells the receiver: *"Transmission complete, stop listening and process what you received."*

## 4. Silence Guard

Add **300ms of silence** before the preamble and after the postamble. This avoids leftover room echo from the previous transmission bleeding into the next one.

---

## 5. Bit Framing (per byte)

Each byte (8 bits of real data) is wrapped like this:

```
[1 Start Bit = 0] [8 Data Bits] [1 Stop Bit = 1]
```

- **Start bit** is always 0 (space frequency) — signals "a new byte begins now"
- **8 data bits** — the actual byte value, sent most-significant-bit first
- **Stop bit** is always 1 (mark frequency) — signals "byte complete"

---

## 6. Full Packet Structure (what actually gets sent, in order)

```
[Silence: 300ms]
[Preamble: 1 second alternating tone]
[Silence: 100ms]
[Header]
  - Filename length (1 byte)
  - Filename (variable length, UTF-8 text)
  - File size in bytes (4 bytes)
  - File type / extension (up to 8 bytes, padded)
[Payload]
  - The actual file content, byte by byte, each wrapped in start/data/stop framing (Section 5)
[Checksum]
  - CRC-8 checksum of the entire payload (1 byte), for the receiver to verify data integrity
[Postamble: end-of-transmission marker]
[Silence: 300ms]
```

Every byte in the Header, Payload, and Checksum sections uses the same bit framing from Section 5.

---

## 7. Error Handling Rules

- If the receiver's calculated checksum does not match the transmitted checksum, the app must show **"Transfer failed — data corrupted, please try again"** rather than saving a corrupted file.
- If no valid preamble is detected within a reasonable listening window, show **"No signal detected."**
- (Optional, Phase 2 stretch goal) Add Hamming(7,4) error-correcting code to the payload bits, allowing the receiver to auto-correct single-bit errors instead of failing the whole transfer.

---

## 8. Values To Revisit In Phase 3 (after real-world testing)

- Baud rate may be increased (e.g., to 75 or 100) if testing shows low error rates at 50 baud, to speed up transfer.
- Frequencies may be adjusted if a specific device's speaker/mic combination performs poorly at 1900/2300 Hz.
- Any change here must be updated in this document and re-tested across all 3 platforms before being finalized.

---

**Reference:** These design choices are informed by real-world acoustic data-transfer systems such as ggwave, which uses frequencies in a similar 1.8–6.3 kHz range and achieves reliable low-speed transfer (8–16 bytes/sec in robust mode) over open air between devices.