// ============================================================
// FSK DECODER — Person B's job
// Matches the team SPEC.md exactly.
// 
// HOW IT WORKS (in plain words):
//   1. Capture microphone audio in real-time using Web Audio API
//   2. Every 20ms (one "bit window"), run the Goertzel algorithm
//      on that chunk of audio to measure energy at 1900 Hz and 2300 Hz
//   3. Whichever frequency has MORE energy → that's the bit (0 or 1)
//   4. Collect bits, find the start bit (0) to align byte boundaries
//   5. Extract 8 data bits per byte, check stop bit, convert to character
//   6. Display the reconstructed text
// ============================================================

// ── SPEC VALUES (must match SPEC.md and Person A's encoder exactly) ──
const SPEC = {
  SAMPLE_RATE:    44100,   // audio snapshots per second
  SPACE_FREQ:     1900,    // Hz — represents bit 0
  MARK_FREQ:      2300,    // Hz — represents bit 1
  PREAMBLE_FREQ1: 1900,    // Hz — preamble alternates between these two
  PREAMBLE_FREQ2: 2300,    // Hz
  POSTAMBLE_FREQ: 2700,    // Hz — 3 × 300ms tones signal end of transmission
  BAUD_RATE:      50,      // bits per second
  AMPLITUDE:      0.75,    // 75% volume (receiver side — not used here, just for reference)
};

// Derived values
const SAMPLES_PER_BIT = Math.round(SPEC.SAMPLE_RATE / SPEC.BAUD_RATE); // = 882 samples per bit
const BIT_DURATION_MS = 1000 / SPEC.BAUD_RATE;                         // = 20 ms per bit

// ── STATE ──
let audioContext   = null;
let mediaStream    = null;
let processorNode  = null;
let analyserNode   = null;
let isListening    = false;

// Buffer to accumulate raw audio samples from the mic
let sampleBuffer   = [];

// Decoded bits accumulate here until we have enough to form bytes
let bitBuffer      = [];

// Final decoded text output
let decodedText    = '';

// Tracks whether we have detected the preamble yet
// (we don't try to decode bits until after the preamble is found)
let preambleDetected = false;
let preambleWindowCount = 0;   // counts consecutive preamble-like windows seen
const PREAMBLE_THRESHOLD = 15; // need ~15 alternating windows (≈0.3 sec) to confirm preamble

// Track last decoded bit to detect the alternating preamble pattern
let lastPreambleBit = -1;
let preambleAltCount = 0;

// ============================================================
// GOERTZEL ALGORITHM
// ============================================================
// In plain words: instead of running a full FFT (which analyses
// ALL frequencies), Goertzel only checks ONE specific frequency.
// We run it twice — once for 1900 Hz, once for 2300 Hz — and
// compare the energy results.
//
// The math: it accumulates a running sum that resonates at the
// target frequency. More resonance = more energy at that frequency.
//
// Returns: a number representing the signal "power" (energy)
//          at the target frequency within the given samples.
//
function goertzel(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = Math.round((N * targetFreq) / sampleRate);
  const omega = (2.0 * Math.PI * k) / N;
  const cosine = Math.cos(omega);
  const coeff = 2.0 * cosine;

  let s_prev  = 0;
  let s_prev2 = 0;

  for (let i = 0; i < N; i++) {
    const s = samples[i] + coeff * s_prev - s_prev2;
    s_prev2 = s_prev;
    s_prev  = s;
  }

  // Return the power (magnitude squared — no need for square root here)
  const power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
  return power;
}

// ============================================================
// DETECT BIT IN ONE WINDOW OF SAMPLES
// ============================================================
// Given exactly SAMPLES_PER_BIT samples, returns 0 or 1.
// Whichever frequency (1900 or 2300 Hz) has MORE energy → that's the bit.
//
function detectBit(samples) {
  const energySpace = goertzel(samples, SPEC.SPACE_FREQ, SPEC.SAMPLE_RATE); // energy at 1900 Hz
  const energyMark  = goertzel(samples, SPEC.MARK_FREQ,  SPEC.SAMPLE_RATE); // energy at 2300 Hz
  return energyMark > energySpace ? 1 : 0; // 1 if 2300 Hz dominates, 0 if 1900 Hz dominates
}

// ============================================================
// DETECT POSTAMBLE (end-of-transmission signal)
// ============================================================
// The postamble is 3 × 300ms tones at 2700 Hz.
// If we detect strong 2700 Hz energy, we're done receiving.
//
function detectPostamble(samples) {
  const energyPost  = goertzel(samples, SPEC.POSTAMBLE_FREQ, SPEC.SAMPLE_RATE);
  const energySpace = goertzel(samples, SPEC.SPACE_FREQ,     SPEC.SAMPLE_RATE);
  const energyMark  = goertzel(samples, SPEC.MARK_FREQ,      SPEC.SAMPLE_RATE);
  // If 2700 Hz is clearly stronger than both data frequencies → postamble detected
  return energyPost > energySpace * 2 && energyPost > energyMark * 2;
}

// ============================================================
// DECODE BITS → BYTES → TEXT
// ============================================================
// The bit framing per byte is: [Start=0] [Bit7][Bit6][Bit5][Bit4][Bit3][Bit2][Bit1][Bit0] [Stop=1]
// That's 10 bits total per byte (character).
// We look for the start bit (0), read 8 data bits (MSB first), check stop bit (1).
//
function decodeBitsToText(bits) {
  let text = '';
  let i = 0;

  while (i < bits.length - 9) {
    // Look for a start bit (0)
    if (bits[i] !== 0) {
      i++;
      continue;
    }

    // We found a start bit — check if we have enough bits for a full frame
    if (i + 9 >= bits.length) break;

    // Read 8 data bits (MSB first — matches Person A's encoder)
    let byteVal = 0;
    for (let b = 0; b < 8; b++) {
      byteVal = (byteVal << 1) | bits[i + 1 + b];
    }

    // Check stop bit (should be 1)
    const stopBit = bits[i + 9];
    if (stopBit === 1) {
      // Valid frame! Convert byte value to character
      if (byteVal >= 32 && byteVal <= 126) {
        // Only printable ASCII characters
        text += String.fromCharCode(byteVal);
      }
      i += 10; // move past this full frame
    } else {
      // Bad stop bit — framing error, skip one bit and try again
      i++;
    }
  }

  return text;
}

// ============================================================
// PROCESS INCOMING AUDIO SAMPLES
// ============================================================
// This is called continuously as mic audio comes in.
// We chop it into 20ms windows and decode each window as one bit.
//
function processAudioSamples(newSamples) {
  // Add new samples to our buffer
  for (let i = 0; i < newSamples.length; i++) {
    sampleBuffer.push(newSamples[i]);
  }

  // Process complete bit windows
  while (sampleBuffer.length >= SAMPLES_PER_BIT) {
    const window = sampleBuffer.splice(0, SAMPLES_PER_BIT);
    const floatWindow = new Float32Array(window);

    // Check for postamble first
    if (preambleDetected && detectPostamble(floatWindow)) {
      // End of transmission!
      finishDecoding();
      return;
    }

    const bit = detectBit(floatWindow);

    if (!preambleDetected) {
      // We're still searching for the preamble
      // The preamble is alternating 0s and 1s rapidly
      detectPreamble(bit);
    } else {
      // Preamble found — start collecting data bits
      bitBuffer.push(bit);
      updateLiveDisplay();
    }
  }
}

// ============================================================
// PREAMBLE DETECTION
// ============================================================
// The preamble is ~1 second of rapidly alternating 1900/2300 Hz tones.
// We detect it by looking for many consecutive alternating bits (0,1,0,1,...).
//
function detectPreamble(bit) {
  if (lastPreambleBit === -1) {
    lastPreambleBit = bit;
    preambleAltCount = 1;
    return;
  }

  if (bit !== lastPreambleBit) {
    // It alternated — good sign!
    preambleAltCount++;
    lastPreambleBit = bit;

    if (preambleAltCount >= PREAMBLE_THRESHOLD) {
      // Confirmed preamble! Start collecting data bits.
      preambleDetected = true;
      bitBuffer = []; // clear anything accumulated during preamble search
      updateStatus('🟢 Preamble detected! Receiving data...');
      console.log('Preamble detected after', preambleAltCount, 'alternating windows');
    }
  } else {
    // Same bit twice — reset alternation counter
    preambleAltCount = 1;
    lastPreambleBit = bit;
  }
}

// ============================================================
// FINISH DECODING (called when postamble is detected or user stops)
// ============================================================
function finishDecoding() {
  const decoded = decodeBitsToText(bitBuffer);
  decodedText += decoded;
  updateOutputDisplay(decodedText);
  updateStatus('✅ Transmission complete!');

  // Reset for next transmission
  bitBuffer = [];
  preambleDetected = false;
  lastPreambleBit = -1;
  preambleAltCount = 0;

  console.log('Decoded text:', decoded);
  console.log('Total bits received:', bitBuffer.length);
}

// ============================================================
// LIVE DISPLAY (shows running bit count while receiving)
// ============================================================
function updateLiveDisplay() {
  const el = document.getElementById('bit-count');
  if (el) el.textContent = `Bits received: ${bitBuffer.length}`;
}

function updateStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function updateOutputDisplay(text) {
  const el = document.getElementById('decoded-output');
  if (el) el.textContent = text || '(nothing decoded yet)';
}

// ============================================================
// START LISTENING (called when user clicks "Start Listening")
// ============================================================
async function startListening() {
  if (isListening) return;

  try {
    // Ask the browser for microphone access
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new AudioContext({ sampleRate: SPEC.SAMPLE_RATE });

    // Connect mic → script processor → detect bits
    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessorNode gives us raw audio samples in real-time
    // Buffer size 2048 = ~46ms of audio per callback at 44100 Hz
    // We'll chop it into 20ms windows internally
    processorNode = audioContext.createScriptProcessor(2048, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!isListening) return;
      const inputData = event.inputBuffer.getChannelData(0); // Float32Array of mic samples
      processAudioSamples(inputData);
    };

    source.connect(processorNode);
    processorNode.connect(audioContext.destination);

    isListening = true;

    // Reset state
    sampleBuffer = [];
    bitBuffer = [];
    decodedText = '';
    preambleDetected = false;
    lastPreambleBit = -1;
    preambleAltCount = 0;

    updateStatus('🎙️ Listening... waiting for preamble signal.');
    updateOutputDisplay('');
    document.getElementById('start-btn').disabled = true;
    document.getElementById('stop-btn').disabled  = false;

    console.log('Decoder started. SAMPLES_PER_BIT:', SAMPLES_PER_BIT, '| BIT_DURATION_MS:', BIT_DURATION_MS);

  } catch (err) {
    updateStatus('❌ Microphone error: ' + err.message);
    console.error(err);
  }
}

// ============================================================
// STOP LISTENING
// ============================================================
function stopListening() {
  if (!isListening) return;

  isListening = false;

  // Decode whatever bits we have so far (even if postamble wasn't received)
  if (bitBuffer.length > 0) {
    finishDecoding();
  }

  // Cleanup audio resources
  if (processorNode) { processorNode.disconnect(); processorNode = null; }
  if (audioContext)  { audioContext.close();        audioContext  = null; }
  if (mediaStream)   {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  updateStatus('🔴 Stopped listening.');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('stop-btn').disabled  = true;
}

// ============================================================
// CLEAR OUTPUT
// ============================================================
function clearOutput() {
  decodedText = '';
  bitBuffer   = [];
  updateOutputDisplay('');
  updateStatus('Cleared. Ready to listen.');
}

// ============================================================
// SELF-TEST: Run the decoder on a known bit sequence
// (matches what Person A's encoder produces for "Hi")
// ============================================================
function runSelfTest() {
  // "Hi" in framed bits (from Person A's verified output):
  // H = 0x48 = 72 → [start=0] 0 1 0 0 1 0 0 0 [stop=1]
  // i = 0x69 = 105 → [start=0] 0 1 1 0 1 0 0 1 [stop=1]
  const testBits = [
    0, 0,1,0,0,1,0,0,0, 1,  // 'H'
    0, 0,1,1,0,1,0,0,1, 1   // 'i'
  ];
  const result = decodeBitsToText(testBits);
  const passed = result === 'Hi';
  alert(`Self-Test ${passed ? '✅ PASSED' : '❌ FAILED'}\nInput bits → "${result}" (expected "Hi")`);
  console.log('Self-test result:', result, '| Expected: Hi | Pass:', passed);
}
