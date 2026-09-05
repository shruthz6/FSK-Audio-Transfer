// FSK Audio Encoder — Person A
// This file converts binary file data/text into an actual audio signal, following
// SPEC.md exactly (50 baud, 1900/2300 Hz, 20ms/bit).
// Uses Continuous Phase FSK (CPFSK) to eliminate audio phase clicks over speakers.

const SPEC = {
  SPACE_FREQ: 1900,              // bit = 0 (1900 Hz)
  MARK_FREQ: 2300,               // bit = 1 (2300 Hz)
  BAUD_RATE: 50,                 // 50 bits per second
  BIT_DURATION_SEC: 1 / 50,      // 20 ms per bit (0.02s)
  SAMPLE_RATE: 44100,            // default audio sample rate
  PREAMBLE_DURATION_SEC: 1.0,    // alternating tone before data (50 windows)
  PREAMBLE_THRESHOLD: 36,        // ~36 valid alternating windows for acoustic tolerance
  POSTAMBLE_FREQ: 2700,          // distinct "end of transmission" tone (2700 Hz)
  POSTAMBLE_TONE_DURATION_SEC: 0.3,
  POSTAMBLE_TONE_COUNT: 3,
  SILENCE_GUARD_SEC: 0.3,        // 300ms silence before preamble & after postamble
  SILENCE_POST_PREAMBLE_SEC: 0.1, // 100ms silence after preamble
  AMPLITUDE: 0.75,               // 75% volume scaling to avoid distortion/clipping
};

/**
 * STEP 1: Convert raw bytes into framed bit sequence.
 * Each byte becomes: [start bit = 0] [8 data bits, MSB first] [stop bit = 1]
 * Matches Section 5 of SPEC.md.
 */
function bytesToFramedBits(bytes) {
  const bits = [];
  for (const byte of bytes) {
    bits.push(0); // start bit
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1); // 8 data bits, MSB first
    }
    bits.push(1); // stop bit
  }
  return bits;
}

/** Legacy helper for string input */
function textToFramedBits(text) {
  const bytes = new TextEncoder().encode(text);
  return bytesToFramedBits(bytes);
}

/**
 * STEP 2: Turn bits into audio sample data using Continuous Phase FSK (CPFSK).
 * Prevents phase discontinuities/clicks between bit transitions.
 */
function bitsToSamples(bits, sampleRate = SPEC.SAMPLE_RATE, startPhase = 0) {
  const samplesPerBit = Math.round(sampleRate * SPEC.BIT_DURATION_SEC);
  const samples = new Float32Array(samplesPerBit * bits.length);

  let sampleIndex = 0;
  let phase = startPhase;

  for (const bit of bits) {
    const freq = bit === 1 ? SPEC.MARK_FREQ : SPEC.SPACE_FREQ;
    const phaseStep = (2 * Math.PI * freq) / sampleRate;
    for (let i = 0; i < samplesPerBit; i++) {
      samples[sampleIndex++] = SPEC.AMPLITUDE * Math.sin(phase);
      phase += phaseStep;
    }
  }

  return { samples, endPhase: phase };
}

/**
 * STEP 3: Generate the preamble — 1 second of alternating mark/space tone (CPFSK).
 */
function generatePreambleSamples(sampleRate = SPEC.SAMPLE_RATE, startPhase = 0) {
  const bitsNeeded = Math.round(SPEC.PREAMBLE_DURATION_SEC / SPEC.BIT_DURATION_SEC);
  const bits = [];
  for (let i = 0; i < bitsNeeded; i++) {
    bits.push(i % 2); // alternates 0, 1, 0, 1 ...
  }
  return bitsToSamples(bits, sampleRate, startPhase);
}

/**
 * STEP 4: Generate the postamble — 3 tones at POSTAMBLE_FREQ (2700 Hz, 300ms each).
 */
function generatePostambleSamples(sampleRate = SPEC.SAMPLE_RATE, startPhase = 0) {
  const samplesPerTone = Math.round(sampleRate * SPEC.POSTAMBLE_TONE_DURATION_SEC);
  const samples = new Float32Array(samplesPerTone * SPEC.POSTAMBLE_TONE_COUNT);

  let idx = 0;
  let phase = startPhase;
  const phaseStep = (2 * Math.PI * SPEC.POSTAMBLE_FREQ) / sampleRate;

  for (let tone = 0; tone < SPEC.POSTAMBLE_TONE_COUNT; tone++) {
    for (let i = 0; i < samplesPerTone; i++) {
      samples[idx++] = SPEC.AMPLITUDE * Math.sin(phase);
      phase += phaseStep;
    }
  }

  return { samples, endPhase: phase };
}

/** Generate silence of a given duration (array of zeros). */
function generateSilenceSamples(durationSec, sampleRate = SPEC.SAMPLE_RATE) {
  return new Float32Array(Math.round(sampleRate * durationSec));
}

/**
 * CRC-8 checksum (polynomial 0x07, init 0x00)
 * Standard test vector: crc8(TextEncoder("123456789")) === 0xF4
 */
function crc8(bytes) {
  let crc = 0x00;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
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
 * [filename length: 1 byte] [filename: UTF-8] [file size: 4 bytes big-endian] [file type: 8 bytes padded]
 */
function buildFileHeader(filename, fileSizeBytes) {
  const filenameBytes = new TextEncoder().encode(filename);
  if (filenameBytes.length > 255) {
    throw new Error('Filename too long (max 255 UTF-8 bytes)');
  }
  if (filenameBytes.length === 0) {
    throw new Error('Filename cannot be empty');
  }

  const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'bin';
  const extPadded = ext.padEnd(8, '\0').slice(0, 8);
  const extBytes = new TextEncoder().encode(extPadded);

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
 * Builds the FULL packet: [header] [payload bytes] [1-byte CRC-8 over payload]
 * Accepts Uint8Array, ArrayBuffer, or string payload.
 */
function buildFullPacket(payload, filename = 'message.txt') {
  let payloadBytes;
  if (payload instanceof Uint8Array) {
    payloadBytes = payload;
  } else if (payload instanceof ArrayBuffer) {
    payloadBytes = new Uint8Array(payload);
  } else if (typeof payload === 'string') {
    payloadBytes = new TextEncoder().encode(payload);
  } else if (payload && typeof payload === 'object' && payload.length !== undefined) {
    payloadBytes = new Uint8Array(payload);
  } else {
    payloadBytes = new TextEncoder().encode(String(payload || ''));
  }

  if (payloadBytes.length > 2048) {
    throw new Error(`File size (${(payloadBytes.length / 1024).toFixed(1)} KB) exceeds maximum 2 KB limit for 50 baud FSK audio transfer. Transmitting larger files requires gigabytes of RAM for audio buffers and hours of playback.`);
  }

  const header = buildFileHeader(filename, payloadBytes.length);

  // Per SPEC.md Section 6: CRC-8 checksum of the entire payload
  const checksum = crc8(payloadBytes);

  const fullPacket = new Uint8Array(header.length + payloadBytes.length + 1);
  let offset = 0;
  fullPacket.set(header, offset); offset += header.length;
  fullPacket.set(payloadBytes, offset); offset += payloadBytes.length;
  fullPacket[offset] = checksum;

  return fullPacket;
}

/**
 * STEP 5: Combine into audio samples per SPEC.md Section 6:
 * [300ms silence] -> [1s preamble] -> [100ms silence] -> [data bits] -> [postamble] -> [300ms silence]
 */
function packetToAudioSamples(payload, filename = 'message.txt', sampleRate = SPEC.SAMPLE_RATE) {
  const silence300 = generateSilenceSamples(SPEC.SILENCE_GUARD_SEC, sampleRate);
  const silence100 = generateSilenceSamples(SPEC.SILENCE_POST_PREAMBLE_SEC, sampleRate);

  let currentPhase = 0;
  const preambleObj = generatePreambleSamples(sampleRate, currentPhase);
  currentPhase = preambleObj.endPhase;

  const packet = buildFullPacket(payload, filename);
  const dataBits = bytesToFramedBits(packet);

  const dataObj = bitsToSamples(dataBits, sampleRate, currentPhase);
  currentPhase = dataObj.endPhase;

  const postambleObj = generatePostambleSamples(sampleRate, currentPhase);

  const totalLength =
    silence300.length * 2 + preambleObj.samples.length + silence100.length + dataObj.samples.length + postambleObj.samples.length;
  const out = new Float32Array(totalLength);

  let offset = 0;
  out.set(silence300, offset); offset += silence300.length;
  out.set(preambleObj.samples, offset); offset += preambleObj.samples.length;
  out.set(silence100, offset); offset += silence100.length;
  out.set(dataObj.samples, offset); offset += dataObj.samples.length;
  out.set(postambleObj.samples, offset); offset += postambleObj.samples.length;
  out.set(silence300, offset);

  return out;
}

/** Legacy wrapper for text */
function textToFullAudioSamples(text) {
  return packetToAudioSamples(text, 'message.txt');
}

/**
 * STEP 6: Play generated audio via Web Audio API using hardware-matched sample rate.
 */
async function playPacket(payload, filename = 'message.txt') {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContextClass();
  const sampleRate = audioCtx.sampleRate || SPEC.SAMPLE_RATE;

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const samples = packetToAudioSamples(payload, filename, sampleRate);
  const buffer = audioCtx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();

  return new Promise((resolve) => {
    source.onended = () => {
      audioCtx.close();
      resolve();
    };
  });
}

/** Legacy wrapper */
async function playText(text) {
  return playPacket(text, 'message.txt');
}

window.FSKEncoder = {
  SPEC,
  crc8,
  buildFileHeader,
  buildFullPacket,
  bytesToFramedBits,
  textToFramedBits,
  bitsToSamples,
  generatePreambleSamples,
  generatePostambleSamples,
  generateSilenceSamples,
  packetToAudioSamples,
  textToFullAudioSamples,
  playPacket,
  playText,
};
