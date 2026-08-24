"use client";

import { useEffect } from "react";

// ============================================================
// 📈 Pixel da Meta + GA4 nas páginas públicas de captação. Injetados no
// mount (client-side) — a CSP do app é report-only, e as páginas /f/* são
// públicas. PageView dispara na carga; a conversão de LEAD é disparada
// pelos componentes (form/quiz/chat) via trackLead() quando o lead entra.
// Sem ids configurados, nada é injetado e trackLead() vira no-op.
// ============================================================

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/** Conversão de lead — chamada pelos componentes ao capturar o contato. */
export function trackLead() {
  try {
    window.fbq?.("track", "Lead");
    window.gtag?.("event", "generate_lead");
  } catch {
    // rastreio nunca pode quebrar a página
  }
}

export function TrackingScripts({
  metaPixelId,
  ga4Id,
}: {
  metaPixelId: string | null;
  ga4Id: string | null;
}) {
  useEffect(() => {
    if (metaPixelId && !window.fbq) {
      // Bootstrap padrão do Pixel da Meta (fila até o fbevents.js carregar).
      const fbq = ((...args: unknown[]) => {
        (fbq as unknown as { queue: unknown[] }).queue.push(args);
      }) as unknown as { (...args: unknown[]): void; queue: unknown[]; loaded: boolean; version: string };
      fbq.queue = [];
      fbq.loaded = true;
      fbq.version = "2.0";
      window.fbq = fbq;
      window._fbq = fbq;
      const s = document.createElement("script");
      s.async = true;
      s.src = "https://connect.facebook.net/en_US/fbevents.js";
      document.head.appendChild(s);
      window.fbq("init", metaPixelId);
      window.fbq("track", "PageView");
    }
    if (ga4Id && !window.gtag) {
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() {
        // O GA4 espera o objeto `arguments` real no dataLayer.
        // eslint-disable-next-line prefer-rest-params
        window.dataLayer!.push(arguments);
      };
      window.gtag("js", new Date());
      window.gtag("config", ga4Id);
      const s = document.createElement("script");
      s.async = true;
      s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4Id)}`;
      document.head.appendChild(s);
    }
  }, [metaPixelId, ga4Id]);

  return null;
}
