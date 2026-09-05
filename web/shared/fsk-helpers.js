(function () {
  function packetToAudioSamples(payload, filename) {
    return window.FSKEncoder.packetToAudioSamples(payload, filename);
  }

  async function playPacket(payload, filename) {
    return window.FSKEncoder.playPacket(payload, filename);
  }

  window.FSKHelpers = { packetToAudioSamples, playPacket };
})();

