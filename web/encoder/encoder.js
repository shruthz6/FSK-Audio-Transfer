// FSK Audio Encoder — Person A
// This file converts text into an actual audio signal, following the rules
// in SPEC.md. Every number below (frequencies, baud rate, etc.) comes
// directly from SPEC.md — if the spec ever changes, update it here too.

const SPEC = {
  SPACE_FREQ: 1900,              // bit = 0
  MARK_FREQ: 2300,               // bit = 1
  BAUD_RATE: 50,                 // bits per second
  BIT_DURATION_SEC: 1 / 50,      // 20 ms per bit
  SAMPLE_RATE: 44100,            // standard audio sample rate
  PREAMBLE_DURATION_SEC: 1.0,    // alternating tone before data
  POSTAMBLE_FREQ: 2700,          // distinct "end of transmission" tone
  POSTAMBLE_TONE_DURATION_SEC: 0.3,
  POSTAMBLE_TONE_COUNT: 3,
  SILENCE_GUARD_SEC: 0.3,        // silence before/after transmission
};

/**
 * STEP 1: Convert text into a "framed" bit sequence.
 * Each byte becomes: [start bit = 0] [8 data bits, MSB first] [stop bit = 1]
 * This matches Section 5 of SPEC.md exactly.
 */
function textToFramedBits(text) {
  const bytes = new TextEncoder().encode(text); // text -> UTF-8 byte values
  const bits = [];

  for (const byte of bytes) {
    bits.push(0); // start bit
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1); // 8 data bits, most significant bit first
    }
    bits.push(1); // stop bit
  }

  return bits;
}

/**
 * STEP 2: Turn an array of bits (0s and 1s) into actual audio sample data.
 * For each bit, generate a short sine wave at either MARK_FREQ or SPACE_FREQ,
 * lasting exactly BIT_DURATION_SEC seconds.
 */
function bitsToSamples(bits) {
  const samplesPerBit = Math.round(SPEC.SAMPLE_RATE * SPEC.BIT_DURATION_SEC);
  const samples = new Float32Array(samplesPerBit * bits.length);

  let sampleIndex = 0;
  for (const bit of bits) {
    const freq = bit === 1 ? SPEC.MARK_FREQ : SPEC.SPACE_FREQ;
    for (let i = 0; i < samplesPerBit; i++) {
      const t = i / SPEC.SAMPLE_RATE;
      samples[sampleIndex++] = Math.sin(2 * Math.PI * freq * t);
    }
  }

  return samples;
}

/**
 * STEP 3: Generate the preamble — 1 second of alternating mark/space tone.
 * This is the "get ready, data is coming" signal from SPEC.md Section 2.
 */
function generatePreambleSamples() {
  const bitsNeeded = Math.round(SPEC.PREAMBLE_DURATION_SEC / SPEC.BIT_DURATION_SEC);
  const bits = [];
  for (let i = 0; i < bitsNeeded; i++) {
    bits.push(i % 2); // alternates 0, 1, 0, 1 ...
  }
  return bitsToSamples(bits);
}

/**
 * STEP 4: Generate the postamble — 3 tones at POSTAMBLE_FREQ.
 * This is the "transmission complete" signal from SPEC.md Section 3.
 */
function generatePostambleSamples() {
  const samplesPerTone = Math.round(SPEC.SAMPLE_RATE * SPEC.POSTAMBLE_TONE_DURATION_SEC);
  const samples = new Float32Array(samplesPerTone * SPEC.POSTAMBLE_TONE_COUNT);

  let idx = 0;
  for (let tone = 0; tone < SPEC.POSTAMBLE_TONE_COUNT; tone++) {
    for (let i = 0; i < samplesPerTone; i++) {
      const t = i / SPEC.SAMPLE_RATE;
      samples[idx++] = Math.sin(2 * Math.PI * SPEC.POSTAMBLE_FREQ * t);
    }
  }

  return samples;
}

/** Generate silence of a given duration (an array of zeros). */
function generateSilenceSamples(durationSec) {
  return new Float32Array(Math.round(SPEC.SAMPLE_RATE * durationSec));
}

/**
 * STEP 5: Combine everything into the final audio signal, in the exact
 * order defined in SPEC.md Section 6:
 * silence -> preamble -> data -> postamble -> silence
 * (Note: file header + checksum are Phase 2 additions — not included yet.)
 */
function textToFullAudioSamples(text) {
  const silence = generateSilenceSamples(SPEC.SILENCE_GUARD_SEC);
  const preamble = generatePreambleSamples();
  const packet = buildFullPacket(text);
  const dataBits = bytesToFramedBits(packet); 
  const data = bitsToSamples(dataBits);
  const postamble = generatePostambleSamples();

  const totalLength =
    silence.length * 2 + preamble.length + data.length + postamble.length;
  const out = new Float32Array(totalLength);

  let offset = 0;
  out.set(silence, offset); offset += silence.length;
  out.set(preamble, offset); offset += preamble.length;
  out.set(data, offset); offset += data.length;
  out.set(postamble, offset); offset += postamble.length;
  out.set(silence, offset); offset += silence.length;

  return out;
}

/**
 * STEP 6: Play the generated audio out loud using the Web Audio API.
 * Returns a Promise that resolves when playback finishes.
 */
async function playText(text) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextClass({ sampleRate: SPEC.SAMPLE_RATE });

  const samples = textToFullAudioSamples(text);
  const buffer = audioCtx.createBuffer(1, samples.length, SPEC.SAMPLE_RATE);
  buffer.copyToChannel(samples, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();

  return new Promise((resolve) => {
    source.onended = () => resolve();
  });
}

// ============================================================
// PHASE 2 ADDITIONS — Person A
// Add this code into web/encoder/encoder.js, ABOVE the line:
//   window.FSKEncoder = { ... }
// ============================================================

/**
 * CRC-8 checksum (polynomial 0x07) — verified against the official
 * CRC-8 test vector: crc8("123456789") === 0xF4
 */
function crc8(bytes) {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      } else {
        crc = (crc << 1) & 0xFF;
      }
    }
  }
  return crc;
}

/**
 * Builds the file metadata header per SPEC.md Section 6:
 * [filename length: 1 byte] [filename: variable] [file size: 4 bytes] [file type: 8 bytes, padded]
 */
function buildFileHeader(filename, fileSizeBytes) {
  const filenameBytes = new TextEncoder().encode(filename);
  if (filenameBytes.length > 255) {
    throw new Error('Filename too long (max 255 bytes)');
  }

  // Pull the extension from the filename (default to 'txt' if none found)
  const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1] : 'txt';
  const extPadded = ext.padEnd(8, '\0').slice(0, 8);
  const extBytes = new TextEncoder().encode(extPadded);

  // File size as 4 bytes, most significant byte first
  const sizeBytes = new Uint8Array([
    (fileSizeBytes >>> 24) & 0xFF,
    (fileSizeBytes >>> 16) & 0xFF,
    (fileSizeBytes >>> 8) & 0xFF,
    fileSizeBytes & 0xFF,
  ]);

  const header = new Uint8Array(1 + filenameBytes.length + 4 + 8);
  let offset = 0;
  header[offset++] = filenameBytes.length;
  header.set(filenameBytes, offset); offset += filenameBytes.length;
  header.set(sizeBytes, offset); offset += 4;
  header.set(extBytes, offset); offset += 8;

  return header;
}

/**
 * Builds the FULL packet: [header] [payload bytes] [1-byte CRC-8 checksum]
 * This replaces plain text as the thing that gets turned into framed bits + audio.
 */
function buildFullPacket(text, filename = 'message.txt') {
  const payloadBytes = new TextEncoder().encode(text);
  const header = buildFileHeader(filename, payloadBytes.length);

  const headerAndPayload = new Uint8Array(header.length + payloadBytes.length);
  headerAndPayload.set(header, 0);
  headerAndPayload.set(payloadBytes, header.length);

  const checksum = crc8(headerAndPayload);

  const fullPacket = new Uint8Array(headerAndPayload.length + 1);
  fullPacket.set(headerAndPayload, 0);
  fullPacket[headerAndPayload.length] = checksum;

  return fullPacket;
}

/**
 * Same framing logic as before (start/8 data bits/stop), but now generalized
 * to work on any byte array — not just text — since it now needs to frame
 * the header and checksum bytes too.
 */
function bytesToFramedBits(bytes) {
  const bits = [];
  for (const byte of bytes) {
    bits.push(0); // start bit
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
    bits.push(1); // stop bit
  }
  return bits;
}

// ============================================================
// END OF PHASE 2 ADDITIONS
// ============================================================
// Make these available to index.html and, later, to Person C's integration code
window.FSKEncoder = {
  SPEC,
  textToFramedBits,
  textToFullAudioSamples,
  playText,
  crc8,
  buildFileHeader, 
  buildFullPacket 
};