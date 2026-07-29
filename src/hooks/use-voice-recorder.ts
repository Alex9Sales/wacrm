"use client";

// Client-side voice recording (Ogg/Opus via opus-recorder, no server
// transcode) as a reusable hook. Mirrors the WhatsApp composer's recorder so
// the internal chat can record voice notes the same way. `onComplete` fires
// once with the finished File when recording stops (not on cancel).

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/** Vendored opus-recorder worker in /public. */
const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";
/** Hard cap so a forgotten recording can't blow the upload size limit. */
const MAX_SECONDS = 300;

export function useVoiceRecorder(onComplete: (file: File) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef<import("opus-recorder").default | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    if (recording) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === "undefined"
    ) {
      toast.error("A gravação de voz não é suportada neste navegador.");
      return;
    }
    try {
      // Lazy-load the ≈400 KB encoder only when the user actually records.
      const { default: Recorder } = await import("opus-recorder");
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderApplication: 2048, // VOIP — tuned for speech
        encoderSampleRate: 48000,
        streamPages: false, // one callback with the complete file on stop
      });
      cancelledRef.current = false;
      recorder.ondataavailable = (bytes) => {
        if (cancelledRef.current) return;
        const file = new File(
          [bytes as unknown as BlobPart],
          `voz-${Date.now()}.ogg`,
          { type: "audio/ogg" },
        );
        if (file.size === 0) return; // empty take
        onCompleteRef.current(file);
      };
      recorderRef.current = recorder;
      await recorder.start();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      void recorderRef.current?.stop().catch(() => {});
      recorderRef.current = null;
      toast.error("Acesso ao microfone negado ou indisponível.");
    }
  }, [recording]);

  const stop = useCallback(() => {
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearTimer();
    setRecording(false);
    void recorderRef.current?.stop().catch(() => {});
  }, [clearTimer]);

  // Auto-stop at the cap.
  useEffect(() => {
    if (recording && seconds >= MAX_SECONDS) stop();
  }, [recording, seconds, stop]);

  // Tear down on unmount.
  useEffect(
    () => () => {
      clearTimer();
      void recorderRef.current?.stop().catch(() => {});
    },
    [clearTimer],
  );

  return { recording, seconds, start, stop, cancel };
}
