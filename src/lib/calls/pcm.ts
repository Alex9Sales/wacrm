// ============================================================
// Conversores de áudio PCM para as ligações waha-voip.
//
// O transporte de voz (DataChannel do gows e o WebSocket do relay) carrega PCM
// 16 kHz s16le CRU, enquanto o AudioWorklet do navegador fala Float32. Estas
// duas funções fazem a ponte nos dois sentidos.
//
// Vivem aqui (e não dentro do modal de chamada) porque agora há DOIS clientes:
// o modal, que fala direto com o gows, e a escuta/relay da Supervisão, que fala
// com o bridge. Uma cópia divergente significaria áudio distorcido em um dos
// dois — o tipo de bug que só aparece no ouvido.
// ============================================================

/** Float32 (-1..1) do worklet → PCM 16-bit little-endian para a rede. */
export function floatToPcm(samples: Float32Array): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i += 1) {
    let n = samples[i];
    if (Number.isNaN(n)) n = 0;
    else if (n > 1) n = 1;
    else if (n < -1) n = -1;
    view.setInt16(i * 2, n < 0 ? Math.round(n * 32768) : Math.round(n * 32767), true);
  }
  return view.buffer;
}

/** PCM 16-bit little-endian da rede → Float32 (-1..1) para o worklet. */
export function pcmToFloat(buf: ArrayBuffer): Float32Array {
  const view = new DataView(buf);
  const len = Math.floor(buf.byteLength / 2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
