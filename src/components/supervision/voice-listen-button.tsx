'use client';

// ============================================================
// "Ouvir" — escuta ao vivo de uma ligação da IA (relay, modo listen).
//
// O motor não passa a ligação de um peer para outro, então quem quer ouvir não
// fala com o gows: fala com o BRIDGE, que é o dono do áudio. O caminho é
//   navegador --wss--> Traefik --> bridge (relay) --> voz do cliente
// e este modo é de MÃO ÚNICA: só recebe. O microfone nunca é ligado e nada é
// injetado na ligação — o cliente não tem como perceber, e um clique errado não
// atrapalha o atendimento. É por isso que a escuta vem antes do "assumir".
//
// O áudio chega como PCM 16 kHz s16le cru (mesmo formato do resto da pilha) e
// vai para o playback-processor, o mesmo worklet que o modal de chamada usa.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { pcmToFloat } from '@/lib/calls/pcm';

type State = 'idle' | 'connecting' | 'listening';

export function VoiceListenButton({ callId }: { callId: string }) {
  const [state, setState] = useState<State>('idle');
  // Objetos imperativos: ficam em ref para o re-render não recriá-los.
  const wsRef = useRef<WebSocket | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    try {
      wsRef.current?.close();
    } catch {
      /* já fechado */
    }
    wsRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    setState('idle');
  }, []);

  // Sair da página no meio da escuta não pode deixar o socket nem o
  // AudioContext pendurados.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setState('connecting');
    try {
      // O bilhete é assinado pelo servidor e vale ~1 min — o bridge confere
      // sozinho, sem consultar o CRM no meio da ligação.
      const res = await fetch('/api/calls/relay-ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, mode: 'listen' }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        path?: string;
        error?: string;
      };
      if (!res.ok || !data.path) {
        console.error('[escuta] bilhete recusado:', res.status, data.error);
        toast.error(
          res.status === 404
            ? 'Essa ligação já terminou.'
            : 'Não consegui liberar a escuta.',
        );
        stop();
        return;
      }
      // A URL é montada AQUI, com a origem do navegador: o servidor está atrás
      // do proxy e enxerga só o host interno do container.
      const url = `${location.origin.replace(/^http/, 'ws')}${data.path}`;

      const ctx = new AudioContext({ sampleRate: 16000 });
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule('/worklets/playback-processor.js');
      await ctx.resume();
      const playback = new AudioWorkletNode(ctx, 'playback-processor');
      const dest = ctx.createMediaStreamDestination();
      playback.connect(dest);
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = dest.stream;
      audioRef.current = el;
      el.play().catch(() => {});

      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      ws.onopen = () => setState('listening');
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          playback.port.postMessage(pcmToFloat(ev.data));
        }
      };
      ws.onerror = () => {
        toast.error('Não consegui entrar na escuta.');
        stop();
      };
      ws.onclose = (ev) => {
        // 4001/4004 = bilhete recusado ou ligação já encerrada.
        if (ev.code === 4004) toast.info('A ligação já terminou.');
        else if (ev.code === 4001) toast.error('Sem permissão para ouvir.');
        stop();
      };
    } catch (err) {
      // Sobra aqui o que falhou no ÁUDIO (AudioContext/worklet bloqueado) ou
      // rede — o bilhete já foi tratado acima com mensagem própria.
      console.error('[escuta] falhou ao preparar o áudio:', err);
      toast.error('Não consegui abrir o áudio da escuta.');
      stop();
    }
  }, [callId, stop]);

  const busy = state === 'connecting';
  return (
    <button
      type="button"
      onClick={() => (state === 'idle' ? void start() : stop())}
      disabled={busy}
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-60 ${
        state === 'listening'
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-border text-foreground hover:bg-muted'
      }`}
      title={
        state === 'listening'
          ? 'Parar de ouvir'
          : 'Ouvir esta ligação ao vivo (só escuta — o cliente não ouve você)'
      }
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Headphones className="size-3" />
      )}
      {state === 'listening' ? 'Ouvindo' : 'Ouvir'}
    </button>
  );
}
