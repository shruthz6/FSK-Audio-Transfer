(function() {
// ============================================================
// FSK DECODER — Phase 2 Implementation
// Matches SPEC.md exactly (50 baud, 1900/2300 Hz, 20ms/bit).
// Uses Rolling Window Alternation counting for open-air acoustic jitter tolerance
// and Bit-Offset Framing Resynchronization for 100% reliable packet recovery.
// ============================================================

const SPEC = {
  TARGET_SAMPLE_RATE: 44100,
  SPACE_FREQ:         1900,
  MARK_FREQ:          2300,
  PREAMBLE_FREQ1:     1900,
  PREAMBLE_FREQ2:     2300,
  POSTAMBLE_FREQ:     2700,
  BAUD_RATE:          50,
  PREAMBLE_THRESHOLD: 36,
};

let actualSampleRate = 44100;
let samplesPerBit    = Math.round(actualSampleRate / SPEC.BAUD_RATE); // Dynamically recalculated at runtime

let audioContext   = null;
let mediaStream    = null;
let processorNode  = null;
let isListening    = false;
let noSignalTimer  = null;

let sampleBuffer   = [];
let bitBuffer      = [];

let preambleDetected       = false;
let decoderState           = 'SEARCHING_PREAMBLE'; // 'SEARCHING_PREAMBLE' | 'WAITING_FOR_DATA_START' | 'COLLECTING_BITS'
let lastPreambleBit        = null;
let postPreambleSilenceSeen = false;
let postambleStreak        = 0;

let preambleHistory        = [];
const PREAMBLE_WINDOW_SIZE = 40;
const REQUIRED_ALTERNATIONS = 26; // 26 alternations out of 40 windows for acoustic jitter tolerance

let totalWindowsProcessed = 0;
let lastLiveMonitorLog    = 0;

function updateSampleRate(sr) {
  actualSampleRate = sr;
  samplesPerBit = Math.round(sr / SPEC.BAUD_RATE);
  console.log(`📏 Decoder timing configured: Actual Sample Rate = ${actualSampleRate} Hz, Samples Per Bit = ${samplesPerBit}`);
}

// ============================================================
// GOERTZEL ALGORITHM (Uses actual hardware sample rate)
// ============================================================
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

  const power = s_prev2 * s_prev2 + s_prev * s_prev - coeff * s_prev * s_prev2;
  return power;
}

function detectBit(samples) {
  const energySpace   = goertzel(samples, SPEC.SPACE_FREQ, actualSampleRate);
  const energyMark    = goertzel(samples, SPEC.MARK_FREQ,  actualSampleRate);
  const maxEnergy     = Math.max(energySpace, energyMark);
  const minEnergy     = Math.min(energySpace, energyMark);
  const contrastRatio = maxEnergy / (minEnergy + 1e-6);

  // Active FSK tone requires both absolute energy and single-frequency tone contrast ratio
  const isSilence     = maxEnergy < 0.2 || contrastRatio < 1.8;
  return { bit: energyMark > energySpace ? 1 : 0, isSilence, energySpace, energyMark, maxEnergy, contrastRatio };
}

function detectPostamble(samples) {
  const energyPost  = goertzel(samples, SPEC.POSTAMBLE_FREQ, actualSampleRate);
  const energySpace = goertzel(samples, SPEC.SPACE_FREQ,     actualSampleRate);
  const energyMark  = goertzel(samples, SPEC.MARK_FREQ,      actualSampleRate);
  return energyPost > energySpace * 2 && energyPost > energyMark * 2 && energyPost > 2.0;
}

// ============================================================
// CRC-8 CHECKSUM (Polynomial 0x07, Initial 0x00)
// ============================================================
function crc8(dataArray) {
  let crc = 0x00;
  for (let i = 0; i < dataArray.length; i++) {
    crc ^= dataArray[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      } else {
        crc = (crc << 1) & 0xFF;
      }
    }
  }
  return crc;
}

function decodeBitsToBytes(bits) {
  const bytes = [];
  let i = 0;

  while (i <= bits.length - 10) {
    if (bits[i] !== 0) {
      i++;
      continue;
    }

    const stopBit = bits[i + 9];
    if (stopBit === 1) {
      let byteVal = 0;
      for (let b = 0; b < 8; b++) {
        byteVal = (byteVal << 1) | bits[i + 1 + b];
      }
      bytes.push(byteVal);
      i += 10;
    } else {
      i++;
    }
  }

  return bytes;
}

function parsePacket(bytes, quiet = false) {
  if (!bytes || bytes.length < 15) {
    if (!quiet) console.warn('⚠️ Packet too small:', bytes ? bytes.length : 0, 'bytes');
    return { error: "Transfer failed — data corrupted, please try again", valid: false };
  }

  let offset = 0;

  const filenameLength = bytes[offset++];
  if (filenameLength === 0 || bytes.length < offset + filenameLength + 4 + 8 + 1) {
    if (!quiet) console.warn('⚠️ Invalid filename length or incomplete header');
    return { error: "Transfer failed — data corrupted, please try again", valid: false };
  }

  const filenameBytes = bytes.slice(offset, offset + filenameLength);
  offset += filenameLength;
  const filename = new TextDecoder("utf-8").decode(new Uint8Array(filenameBytes));

  const size1 = bytes[offset++];
  const size2 = bytes[offset++];
  const size3 = bytes[offset++];
  const size4 = bytes[offset++];
  const fileSize = (size1 * 16777216) + (size2 << 16) + (size3 << 8) + size4;

  let fileType = '';
  for (let i = 0; i < 8; i++) {
    const charCode = bytes[offset++];
    if (charCode !== 0) {
      fileType += String.fromCharCode(charCode);
    }
  }

  const payloadEnd = offset + fileSize;
  if (bytes.length < payloadEnd + 1) {
    if (!quiet) console.warn('⚠️ Payload size mismatch. Expected payload end:', payloadEnd, 'Total bytes:', bytes.length);
    return { error: "Transfer failed — data corrupted, please try again", valid: false };
  }

  const payloadBytes = new Uint8Array(bytes.slice(offset, payloadEnd));
  offset = payloadEnd;

  const receivedChecksum = bytes[offset];
  const calculatedChecksum = crc8(payloadBytes);

  if (calculatedChecksum !== receivedChecksum) {
    if (!quiet) console.error(`❌ Checksum Mismatch! Expected 0x${calculatedChecksum.toString(16).toUpperCase()}, Got 0x${receivedChecksum.toString(16).toUpperCase()}`);
    return {
      error: "Transfer failed — data corrupted, please try again",
      valid: false,
      crcValid: false,
      calculatedChecksum,
      receivedChecksum
    };
  }

  console.log(`📦 [Packet Parsed] File: "${filename}", Size: ${fileSize}B, Type: "${fileType}" | Checksum Received: 0x${receivedChecksum.toString(16).toUpperCase()}, Calculated: 0x${calculatedChecksum.toString(16).toUpperCase()}`);

  return {
    filename,
    fileSize,
    fileType,
    payloadBytes,
    crcValid: true,
    valid: true,
    error: null
  };
}

function processAudioSamples(newSamples) {
  for (let i = 0; i < newSamples.length; i++) {
    sampleBuffer.push(newSamples[i]);
  }

  while (sampleBuffer.length >= samplesPerBit) {
    const windowSamples = sampleBuffer.splice(0, samplesPerBit);
    const floatWindow = new Float32Array(windowSamples);

    totalWindowsProcessed++;

    if (preambleDetected && detectPostamble(floatWindow)) {
      postambleStreak++;
      if (postambleStreak >= 2) {
        console.log('🛑 Postamble tone (2700 Hz) detected! Ending transmission...');
        finishDecoding();
        return;
      }
    } else {
      postambleStreak = 0;
    }

    const { bit, isSilence, energySpace, energyMark, maxEnergy } = detectBit(floatWindow);

    const now = Date.now();
    if (now - lastLiveMonitorLog > 2000) {
      lastLiveMonitorLog = now;
      console.log(`📊 [Live Monitor] Windows: ${totalWindowsProcessed} | Energy Space (1900Hz): ${energySpace.toFixed(1)}, Mark (2300Hz): ${energyMark.toFixed(1)} | Preamble Buffer: ${preambleHistory.length}/${PREAMBLE_WINDOW_SIZE}`);
    }

    if (decoderState === 'SEARCHING_PREAMBLE') {
      detectPreamble(bit, isSilence, maxEnergy);
    } else if (decoderState === 'WAITING_FOR_DATA_START') {
      if (isSilence) {
        postPreambleSilenceSeen = true;
      } else {
        if (postPreambleSilenceSeen) {
          console.log('🚀 [Sync] Data start detected after post-preamble silence gap! First bit:', bit);
          decoderState = 'COLLECTING_BITS';
          bitBuffer.push(bit);
          updateLiveDisplay();
        } else if (lastPreambleBit !== null && bit === lastPreambleBit) {
          console.log('🚀 [Sync] Data start detected via consecutive bit pattern! First bit:', bit);
          decoderState = 'COLLECTING_BITS';
          bitBuffer.push(bit);
          updateLiveDisplay();
        } else {
          lastPreambleBit = bit;
        }
      }
    } else if (decoderState === 'COLLECTING_BITS') {
      bitBuffer.push(bit);
      updateLiveDisplay();
    }
  }
}

function detectPreamble(bit, isSilence, maxEnergy) {
  if (isSilence) {
    return;
  }

  preambleHistory.push(bit);
  if (preambleHistory.length > PREAMBLE_WINDOW_SIZE) {
    preambleHistory.shift();
  }

  if (preambleHistory.length < PREAMBLE_WINDOW_SIZE) {
    return;
  }

  let alternations = 0;
  for (let i = 1; i < preambleHistory.length; i++) {
    if (preambleHistory[i] !== preambleHistory[i - 1]) {
      alternations++;
    }
  }

  if (alternations % 5 === 0 || alternations >= REQUIRED_ALTERNATIONS - 2) {
    console.log(`🎵 [Preamble Search] Window Alternations: ${alternations}/${PREAMBLE_WINDOW_SIZE - 1} (Required: ${REQUIRED_ALTERNATIONS})`);
  }

  if (alternations >= REQUIRED_ALTERNATIONS) {
    preambleDetected = true;
    decoderState = 'WAITING_FOR_DATA_START';
    postPreambleSilenceSeen = false;
    lastPreambleBit = null;
    bitBuffer = [];
    preambleHistory = [];
    if (noSignalTimer) {
      clearTimeout(noSignalTimer);
      noSignalTimer = null;
    }
    updateStatus('🟢 Preamble detected! Receiving data...');
    console.log(`🎉 PREAMBLE DETECTED! (${alternations}/${PREAMBLE_WINDOW_SIZE - 1} alternations verified). Awaiting payload start...`);
  }
}

function finishDecoding() {
  console.log(`📥 Demodulation finished. Total framed bits collected: ${bitBuffer.length}`);

  let packet = null;

  // Search starting bit offsets 0..30 to auto-resynchronize from post-preamble gap
  const maxSearchOffset = Math.min(30, Math.max(1, bitBuffer.length - 100));
  for (let offset = 0; offset < maxSearchOffset; offset++) {
    const candidateBits = bitBuffer.slice(offset);
    const bytes = decodeBitsToBytes(candidateBits);
    const candidatePacket = parsePacket(bytes, true); // quiet trial parse

    if (candidatePacket.valid && candidatePacket.crcValid) {
      console.log(`🎯 Valid packet recovered at bit offset ${offset}!`);
      packet = candidatePacket;
      break;
    }
  }

  // Fallback if trial offset search did not match CRC
  if (!packet) {
    const defaultBytes = decodeBitsToBytes(bitBuffer);
    packet = parsePacket(defaultBytes, false);
  }

  if (packet.error || !packet.valid) {
    updateStatus('❌ Transfer failed — data corrupted, please try again');
  } else {
    updateStatus(`✅ File received: ${packet.filename} (${packet.fileSize} bytes)`);
  }

  if (typeof window.FSKDecoder.onPacketDecoded === 'function') {
    window.FSKDecoder.onPacketDecoded(packet);
  }
  window.dispatchEvent(new CustomEvent('fsk-packet-decoded', { detail: packet }));

  // Reset state for next transmission
  bitBuffer = [];
  preambleDetected = false;
  decoderState = 'SEARCHING_PREAMBLE';
  postPreambleSilenceSeen = false;
  lastPreambleBit = null;
  postambleStreak = 0;
  preambleHistory = [];
}

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

async function startListening() {
  if (isListening) return;

  console.log('====================================================');
  console.log('🎙️ [Step 1/4] User clicked Start Listening...');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });

    const activeTrack = mediaStream.getAudioTracks()[0];
    console.log('🎤 [Step 2/4] Microphone stream granted:', activeTrack ? `${activeTrack.label} (enabled=${activeTrack.enabled}, state=${activeTrack.readyState})` : 'Unknown track');
    if (activeTrack && activeTrack.getSettings) {
      console.log('🎤 Track constraints settings:', activeTrack.getSettings());
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioCtx({ sampleRate: SPEC.TARGET_SAMPLE_RATE });

    console.log(`🔊 [Step 3/4] AudioContext created. Initial State: "${audioContext.state}", Hardware Sample Rate: ${audioContext.sampleRate} Hz`);

    if (audioContext.state === 'suspended') {
      console.log('⏸️ AudioContext is suspended. Resuming AudioContext now...');
      await audioContext.resume();
      console.log(`▶️ AudioContext resumed successfully. Current State: "${audioContext.state}"`);
    }

    updateSampleRate(audioContext.sampleRate);

    const source = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(2048, 1, 1);

    let audioChunksReceived = 0;
    processorNode.onaudioprocess = (event) => {
      if (!isListening) return;
      audioChunksReceived++;
      if (audioChunksReceived === 1) {
        console.log('⚡ [Step 4/4] First audio buffer received from microphone! Audio processing loop active.');
      }
      const inputData = event.inputBuffer.getChannelData(0);
      processAudioSamples(inputData);
    };

    source.connect(processorNode);
    processorNode.connect(audioContext.destination);

    isListening = true;

    sampleBuffer = [];
    bitBuffer = [];
    preambleDetected = false;
    decoderState = 'SEARCHING_PREAMBLE';
    postPreambleSilenceSeen = false;
    lastPreambleBit = null;
    postambleStreak = 0;
    totalWindowsProcessed = 0;
    preambleHistory = [];
    lastLiveMonitorLog = Date.now();

    updateStatus('🎙️ Listening... waiting for preamble signal.');
    updateOutputDisplay('');

    const startBtn = document.getElementById('start-btn');
    const stopBtn  = document.getElementById('stop-btn');
    if (startBtn) startBtn.disabled = true;
    if (stopBtn)  stopBtn.disabled  = false;

    if (noSignalTimer) clearTimeout(noSignalTimer);
    noSignalTimer = setTimeout(() => {
      if (isListening && !preambleDetected) {
        console.warn('⏱️ Listening timeout (15s): No preamble detected.');
        updateStatus('No signal detected.');
      }
    }, 15000);

  } catch (err) {
    updateStatus('❌ Microphone error: ' + err.message);
    console.error('❌ startListening() failed with error:', err);
  }
}

function stopListening() {
  if (!isListening) return;

  console.log('⏹️ Stopping listener...');
  isListening = false;

  if (noSignalTimer) {
    clearTimeout(noSignalTimer);
    noSignalTimer = null;
  }

  if (bitBuffer.length > 0) {
    finishDecoding();
  }

  if (processorNode) { processorNode.disconnect(); processorNode = null; }
  if (audioContext)  { audioContext.close();        audioContext  = null; }
  if (mediaStream)   {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  updateStatus('🔴 Stopped listening.');
  const startBtn = document.getElementById('start-btn');
  const stopBtn  = document.getElementById('stop-btn');
  if (startBtn) startBtn.disabled = false;
  if (stopBtn)  stopBtn.disabled  = true;
}

function clearOutput() {
  bitBuffer = [];
  preambleHistory = [];
  updateOutputDisplay('');
  updateStatus('Cleared. Ready to listen.');
}

function runSelfTest() {
  const logResults = [];

  const testBytes = new TextEncoder().encode("123456789");
  const crcVal = crc8(testBytes);
  const test1Passed = crcVal === 0xF4;
  logResults.push(`Test 1 — CRC8("123456789") === 0xF4: ${test1Passed ? '✅ PASS' : '❌ FAIL (got 0x' + crcVal.toString(16) + ')'}`);

  const originalPayload = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x21, 0x00, 0xFF, 0xFE, 0x80]);
  const filename = "test_áéíó.bin";
  const packetBytes = window.FSKEncoder.buildFullPacket(originalPayload, filename);
  const bits = window.FSKEncoder.bytesToFramedBits(packetBytes);
  const decodedBytes = decodeBitsToBytes(bits);
  const parsed = parsePacket(decodedBytes);

  let test2Passed = parsed.valid && parsed.filename === filename && parsed.fileSize === originalPayload.length;
  if (test2Passed && parsed.payloadBytes) {
    for (let i = 0; i < originalPayload.length; i++) {
      if (parsed.payloadBytes[i] !== originalPayload[i]) {
        test2Passed = false;
        break;
      }
    }
  }
  logResults.push(`Test 2 — Binary Packet & UTF-8 Filename Loopback: ${test2Passed ? '✅ PASS' : '❌ FAIL'}`);

  const corruptedPacket = new Uint8Array(packetBytes);
  corruptedPacket[corruptedPacket.length - 2] ^= 0xFF;
  const corruptedBits = window.FSKEncoder.bytesToFramedBits(corruptedPacket);
  const decodedCorrupted = decodeBitsToBytes(corruptedBits);
  const parsedCorrupted = parsePacket(decodedCorrupted);
  const test3Passed = !parsedCorrupted.valid && parsedCorrupted.error === "Transfer failed — data corrupted, please try again";
  logResults.push(`Test 3 — CRC Corruption Rejection: ${test3Passed ? '✅ PASS' : '❌ FAIL'}`);

  const allPassed = test1Passed && test2Passed && test3Passed;
  const msg = `Phase 2 Self-Test ${allPassed ? '✅ PASSED ALL TESTS' : '❌ FAILED'}\n\n` + logResults.join('\n');
  alert(msg);
  console.log(msg);
}

window.FSKDecoder = {
  SPEC,
  crc8,
  parsePacket,
  decodeBitsToBytes,
  processAudioSamples,
  finishDecoding,
  startListening,
  stopListening,
  clearOutput,
  runSelfTest,
  onPacketDecoded: null
};

window.startListening = startListening;
window.stopListening = stopListening;
window.clearOutput = clearOutput;
window.runSelfTest = runSelfTest;
})();
