(function() {
// ============================================================
// FSK DECODER — Person B's Phase 2 Task
// Matches the team SPEC.md exactly (Phase 2 packet format).
// ============================================================

const SPEC = {
  SAMPLE_RATE:    44100,   
  SPACE_FREQ:     1900,    
  MARK_FREQ:      2300,    
  PREAMBLE_FREQ1: 1900,    
  PREAMBLE_FREQ2: 2300,    
  POSTAMBLE_FREQ: 2700,    
  BAUD_RATE:      50,      
};

const SAMPLES_PER_BIT = Math.round(SPEC.SAMPLE_RATE / SPEC.BAUD_RATE); 
const BIT_DURATION_MS = 1000 / SPEC.BAUD_RATE;                         

let audioContext   = null;
let mediaStream    = null;
let processorNode  = null;
let isListening    = false;

let sampleBuffer   = [];
let bitBuffer      = [];
let decodedText    = '';

let preambleDetected = false;
let preambleWindowCount = 0;   
const PREAMBLE_THRESHOLD = 48; 

let lastPreambleBit = -1;
let preambleAltCount = 0;

// ============================================================
// GOERTZEL ALGORITHM
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
  const energySpace = goertzel(samples, SPEC.SPACE_FREQ, SPEC.SAMPLE_RATE);
  const energyMark  = goertzel(samples, SPEC.MARK_FREQ,  SPEC.SAMPLE_RATE);
  return energyMark > energySpace ? 1 : 0; 
}

function detectPostamble(samples) {
  const energyPost  = goertzel(samples, SPEC.POSTAMBLE_FREQ, SPEC.SAMPLE_RATE);
  const energySpace = goertzel(samples, SPEC.SPACE_FREQ,     SPEC.SAMPLE_RATE);
  const energyMark  = goertzel(samples, SPEC.MARK_FREQ,      SPEC.SAMPLE_RATE);
  return energyPost > energySpace * 2 && energyPost > energyMark * 2;
}

// ============================================================
// PHASE 2: CRC-8 CHECKSUM
// Polynomial 0x07
// ============================================================
function crc8(dataArray) {
  let crc = 0;
  for (let i = 0; i < dataArray.length; i++) {
    crc ^= dataArray[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = (crc << 1) ^ 0x07;
      } else {
        crc <<= 1;
      }
      crc &= 0xFF; // Keep it 8-bit
    }
  }
  return crc;
}

// ============================================================
// PHASE 2: BITS TO BYTES
// ============================================================
function decodeBitsToBytes(bits) {
  let bytes = [];
  let i = 0;

  while (i < bits.length - 9) {
    if (bits[i] !== 0) {
      i++;
      continue;
    }

    if (i + 9 >= bits.length) break;

    let byteVal = 0;
    for (let b = 0; b < 8; b++) {
      byteVal = (byteVal << 1) | bits[i + 1 + b];
    }

    const stopBit = bits[i + 9];
    if (stopBit === 1) {
      bytes.push(byteVal);
      i += 10; 
    } else {
      i++;
    }
  }

  return bytes;
}

// ============================================================
// PHASE 2: PACKET PARSING
// ============================================================
function parsePacket(bytes) {
  if (bytes.length < 13) return { error: "Packet too small (must be at least 14 bytes)" };

  let offset = 0;

  // 1. Filename length
  const filenameLength = bytes[offset++];
  
  if (bytes.length < offset + filenameLength + 4 + 8 + 1) return { error: "Incomplete packet received" };

  // 2. Filename
  let filename = '';
  for (let i = 0; i < filenameLength; i++) {
    filename += String.fromCharCode(bytes[offset++]);
  }

  // 3. File size (4 bytes MSB)
  const size1 = bytes[offset++];
  const size2 = bytes[offset++];
  const size3 = bytes[offset++];
  const size4 = bytes[offset++];
  const fileSize = (size1 << 24) | (size2 << 16) | (size3 << 8) | size4;

  // 4. File type (8 bytes null padded)
  let fileType = '';
  for (let i = 0; i < 8; i++) {
    const charCode = bytes[offset++];
    if (charCode !== 0) {
      fileType += String.fromCharCode(charCode);
    }
  }

  // 5. Payload
  const payloadEnd = offset + fileSize;
  if (bytes.length < payloadEnd + 1) return { error: "Payload incomplete" };
  
  const payloadBytes = bytes.slice(offset, payloadEnd);
  
  // Convert payload back to string
  let payloadText = '';
  for (let i = 0; i < payloadBytes.length; i++) {
    payloadText += String.fromCharCode(payloadBytes[i]);
  }
  
  offset = payloadEnd;

  // 6. Checksum
  const receivedChecksum = bytes[offset];
  
  // Validate CRC-8 over header + payload
  const dataToVerify = bytes.slice(0, offset);
  const calculatedChecksum = crc8(dataToVerify);
  
  if (calculatedChecksum !== receivedChecksum) {
     return { error: `CRC mismatch! Data corrupted. (Expected 0x${calculatedChecksum.toString(16)}, got 0x${receivedChecksum.toString(16)})` };
  }

  return {
    filename,
    fileSize,
    fileType,
    payloadText,
    valid: true
  };
}

function processAudioSamples(newSamples) {
  for (let i = 0; i < newSamples.length; i++) {
    sampleBuffer.push(newSamples[i]);
  }

  while (sampleBuffer.length >= SAMPLES_PER_BIT) {
    const window = sampleBuffer.splice(0, SAMPLES_PER_BIT);
    const floatWindow = new Float32Array(window);

    if (preambleDetected && detectPostamble(floatWindow)) {
      finishDecoding();
      return;
    }

    const bit = detectBit(floatWindow);

    if (!preambleDetected) {
      detectPreamble(bit);
    } else {
      bitBuffer.push(bit);
      updateLiveDisplay();
    }
  }
}

function detectPreamble(bit) {
  if (lastPreambleBit === -1) {
    lastPreambleBit = bit;
    preambleAltCount = 1;
    return;
  }

  if (bit !== lastPreambleBit) {
    preambleAltCount++;
    lastPreambleBit = bit;

    if (preambleAltCount >= PREAMBLE_THRESHOLD) {
      preambleDetected = true;
      bitBuffer = []; 
      updateStatus('🟢 Preamble detected! Receiving data...');
      console.log('Preamble detected after', preambleAltCount, 'alternating windows');
    }
  } else {
    preambleAltCount = 1;
    lastPreambleBit = bit;
  }
}

// ============================================================
// FINISH DECODING (PHASE 2 UPDATE)
// ============================================================
function finishDecoding() {
  const bytes = decodeBitsToBytes(bitBuffer);
  const packet = parsePacket(bytes);
  
  if (packet.error) {
    decodedText += `\n[⚠️ Transfer failed — ${packet.error}]`;
    updateStatus('❌ Transfer failed (Corruption detected)');
  } else {
    decodedText += `\n[✅ File: ${packet.filename} | Size: ${packet.fileSize}b | Type: ${packet.fileType}]\n`;
    decodedText += packet.payloadText;
    updateStatus('✅ Transmission complete!');
  }
  
  updateOutputDisplay(decodedText);

  // Reset for next transmission
  bitBuffer = [];
  preambleDetected = false;
  lastPreambleBit = -1;
  preambleAltCount = 0;
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

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    audioContext = new AudioContext({ sampleRate: SPEC.SAMPLE_RATE });

    const source = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(2048, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!isListening) return;
      const inputData = event.inputBuffer.getChannelData(0); 
      processAudioSamples(inputData);
    };

    source.connect(processorNode);
    processorNode.connect(audioContext.destination);

    isListening = true;

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

  } catch (err) {
    updateStatus('❌ Microphone error: ' + err.message);
    console.error(err);
  }
}

function stopListening() {
  if (!isListening) return;

  isListening = false;

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
  document.getElementById('start-btn').disabled = false;
  document.getElementById('stop-btn').disabled  = true;
}

function clearOutput() {
  decodedText = '';
  bitBuffer   = [];
  updateOutputDisplay('');
  updateStatus('Cleared. Ready to listen.');
}

function runSelfTest() {
  // Phase 2 Self Test: Simulate a valid packet
  // Filename: "t", Size: 2, Type: "txt", Payload: "Hi"
  const bytes = [
    1, 116,                   // filename length (1), filename "t"
    0, 0, 0, 2,               // size (2 bytes payload)
    116, 120, 116, 0, 0, 0, 0, 0, // type "txt" (padded)
    72, 105                   // payload "Hi"
  ];
  
  const expectedCrc = crc8(bytes);
  bytes.push(expectedCrc);
  
  // Convert these test bytes into framed bits (0 [bits] 1)
  let bits = [];
  for (let i = 0; i < bytes.length; i++) {
    bits.push(0); // Start bit
    let b = bytes[i];
    for (let j = 7; j >= 0; j--) {
      bits.push((b >> j) & 1);
    }
    bits.push(1); // Stop bit
  }

  bitBuffer = bits;
  finishDecoding();
  const passed = decodedText.includes("✅ File: t");
  alert(`Phase 2 Self-Test ${passed ? '✅ PASSED' : '❌ FAILED'}\nCheck decoded output for details.`);
}

window.startListening = startListening; 
window.stopListening = stopListening; 
window.clearOutput = clearOutput; 
window.runSelfTest = runSelfTest; })();
