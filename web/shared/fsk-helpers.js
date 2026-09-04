(function () {
  const SPEC = window.FSKEncoder.SPEC;

  function bytesToFramedBits(bytes) {
    const bits = [];
    for (const byte of bytes) {
      bits.push(0);
      for (let i = 7; i >= 0; i--) {
        bits.push((byte >> i) & 1);
      }
      bits.push(1);
    }
    return bits;
  }

  function bitsToSamples(bits) {
    const samplesPerBit = Math.round(SPEC.SAMPLE_RATE * SPEC.BIT_DURATION_SEC);
    const samples = new Float32Array(samplesPerBit * bits.length);
    let idx = 0;
    for (const bit of bits) {
      const freq = bit === 1 ? SPEC.MARK_FREQ : SPEC.SPACE_FREQ;
      for (let i = 0; i < samplesPerBit; i++) {
        const t = i / SPEC.SAMPLE_RATE;
        samples[idx++] = Math.sin(2 * Math.PI * freq * t);
      }
    }
    return samples;
  }

  function generatePreambleSamples() {
    const bitsNeeded = Math.round(SPEC.PREAMBLE_DURATION_SEC / SPEC.BIT_DURATION_SEC);
    const bits = [];
    for (let i = 0; i < bitsNeeded; i++) bits.push(i % 2);
    return bitsToSamples(bits);
  }

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

  function generateSilenceSamples(durationSec) {
    return new Float32Array(Math.round(SPEC.SAMPLE_RATE * durationSec));
  }

  function packetToAudioSamples(text, filename) {
    const packet = window.FSKEncoder.buildFullPacket(text, filename);
    const dataBits = bytesToFramedBits(packet);

    const silence = generateSilenceSamples(SPEC.SILENCE_GUARD_SEC);
    const preamble = generatePreambleSamples();
    const data = bitsToSamples(dataBits);
    const postamble = generatePostambleSamples();

    const totalLength = silence.length * 2 + preamble.length + data.length + postamble.length;
    const out = new Float32Array(totalLength);
    let offset = 0;
    out.set(silence, offset); offset += silence.length;
    out.set(preamble, offset); offset += preamble.length;
    out.set(data, offset); offset += data.length;
    out.set(postamble, offset); offset += postamble.length;
    out.set(silence, offset);

    return out;
  }

  async function playPacket(text, filename) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContextClass({ sampleRate: SPEC.SAMPLE_RATE });

    const samples = packetToAudioSamples(text, filename);
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

  window.FSKHelpers = { packetToAudioSamples, playPacket };
})();
