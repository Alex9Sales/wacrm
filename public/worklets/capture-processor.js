// AudioWorklet: forwards each mic audio block (Float32) to the main thread,
// which converts it to 16 kHz s16le PCM and pushes it down the waha-voip "pcm"
// DataChannel. Ported verbatim from the waha-voip dashboard dialer.
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
