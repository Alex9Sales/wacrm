"use client";

import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  LayoutTemplate,
  ImageOff,
  CornerDownLeft,
  X,
  ExternalLink,
  Sparkles,
  EyeOff,
  Maximize2,
  Copy,
  User,
  Lock,
  Ban,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { RichText } from "@/lib/inbox/rich-text";
import { GroupText, groupColor } from "@/lib/inbox/group-color";
import { detectCopyCode } from "@/lib/inbox/copy-code";
import { MentionText } from "@/components/inbox/mention-composer";
import type { MentionMember } from "@/lib/inbox/mentions";
import {
  parseCallLog,
  formatCallDuration,
  parseCallPermission,
  formatDayMonth,
  type ParsedCallLog,
  type ParsedCallPermission,
} from "@/lib/inbox/call-log";
import { Phone, PhoneMissed, PhoneOff, ShieldCheck } from "lucide-react";
import { startOutboundCall } from "@/components/calls/incoming-call-modal";

/** Content_text prefix a WhatsApp Pix key card is stored with (see waha.ts). */
const PIX_PREFIX = "💠 Chave Pix";

/** Marker the WAHA provider appends when an inbound template carries buttons
 *  (see templateButtons in waha.ts):
 *  "<body>\n\n🔘 Botões: Confirmar · Link da aula ↗ https://...". A plain label
 *  is a quick-reply (click fires a text reply); "label ↗ url" is a URL/CTA
 *  button (click opens the link). */
const BUTTONS_PREFIX = "🔘 Botões: ";
const BUTTONS_SEP = " · ";
const BUTTONS_URL_SEP = " ↗ ";

interface TemplateBtn {
  label: string;
  /** Set only for a URL/CTA button — the chip opens it instead of replying. */
  url?: string;
}

/** Split a content_text into its body and template buttons, or null when
 *  there's no button line. The marker sits on its own trailing line. */
function parseTemplateButtons(
  txt: string,
): { body: string; buttons: TemplateBtn[] } | null {
  let body: string;
  let line: string;
  const at = txt.lastIndexOf("\n" + BUTTONS_PREFIX);
  if (at >= 0) {
    body = txt.slice(0, at);
    line = txt.slice(at + 1);
  } else if (txt.startsWith(BUTTONS_PREFIX)) {
    body = "";
    line = txt;
  } else {
    return null;
  }
  const buttons = line
    .slice(BUTTONS_PREFIX.length)
    .split(BUTTONS_SEP)
    .map((part): TemplateBtn | null => {
      const s = part.trim();
      if (!s) return null;
      const sep = s.indexOf(BUTTONS_URL_SEP);
      if (sep >= 0) {
        const label = s.slice(0, sep).trim();
        const url = s.slice(sep + BUTTONS_URL_SEP.length).trim();
        if (label && /^https?:\/\//i.test(url)) return { label, url };
      }
      return { label: s };
    })
    .filter((b): b is TemplateBtn => b !== null);
  if (!buttons.length) return null;
  return { body: body.replace(/\s+$/, ""), buttons };
}

/** Content_text prefix a shared contact (vCard) is stored with (see waha.ts
 *  textFromContact): "👤 Contato: <nome> · <telefone> | <nome2> · <telefone2>". */
const CONTACT_PREFIX = "👤 Contato:";

/** Render shared contact(s) as a card with a "Conversar" action that opens
 *  (or creates) that contact's conversation in the inbox. */
function ContactCard({
  text,
  channelId,
}: {
  text: string;
  /** Canal da conversa de origem: abre o contato NELE, não no canal padrão. */
  channelId?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const cards = text
    .replace(/^👤\s*Contato:\s*/u, "")
    .split(" | ")
    .map((part) => {
      const [name, phone] = part.split(" · ");
      return { name: (name ?? "").trim(), phone: (phone ?? "").trim() };
    })
    .filter((c) => c.name || c.phone);

  const open = async (phone: string) => {
    if (!phone || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/conversations/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sem channelId, o resolve cai no canal PADRÃO da conta (o Meta), então
        // "Conversar" criava conversa vazia no canal oficial em vez do waha onde
        // o time trabalha. Passar o canal da conversa de origem mantém o contato
        // no mesmo canal.
        body: JSON.stringify({ phone, channelId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        conversationId?: string;
      };
      if (res.ok && data.conversationId) {
        router.push(`/inbox?c=${data.conversationId}`);
      } else {
        toast.error("Não foi possível abrir a conversa desse contato.");
      }
    } catch {
      toast.error("Não foi possível abrir a conversa desse contato.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-[220px] flex-col gap-1.5">
      {cards.map((c, i) => (
        <div
          key={i}
          className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
            <User className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {c.name || c.phone}
            </p>
            {c.name && c.phone && (
              <p className="truncate text-xs text-muted-foreground">{c.phone}</p>
            )}
          </div>
          {c.phone && (
            <button
              type="button"
              onClick={() => open(c.phone)}
              disabled={busy}
              className="shrink-0 rounded-md px-2.5 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            >
              Conversar
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Render a Pix key card (header + merchant + key) with a copy button. */
function PixCard({ text }: { text: string }) {
  const lines = text.split("\n").filter(Boolean);
  const header = lines[0] ?? PIX_PREFIX;
  const key = lines.length > 1 ? lines[lines.length - 1] : "";
  const merchant = lines.slice(1, -1).join(" ");
  return (
    <div className="min-w-[220px]">
      <p className="text-sm font-semibold text-foreground">{header}</p>
      {merchant && (
        <p className="mt-0.5 text-xs text-muted-foreground">{merchant}</p>
      )}
      {key && (
        <p className="mt-1 break-all font-mono text-sm text-foreground">{key}</p>
      )}
      {key && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(key)
              .then(() => toast.success("Chave Pix copiada."))
              .catch(() => toast.error("Não foi possível copiar."));
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Copy className="h-3.5 w-3.5" />
          Copiar chave
        </button>
      )}
    </div>
  );
}

/** A shared/sent location = a Google Maps link with `q=lat,lng`. Sent pins are
 *  a bare link, inbound ones carry a "📍 Localização" header + optional place
 *  name. Detect either so the bubble shows a compact card, not a raw URL. */
function detectLocation(
  txt: string,
): { header: string; place?: string; url: string } | null {
  const m = txt.match(
    /https?:\/\/[^\s]*google\.[^\s]*maps[^\s]*[?&]q=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?[^\s]*/i,
  );
  if (!m) return null;
  const lines = txt.split("\n").filter(Boolean);
  const header = lines[0]?.startsWith("📍") ? lines[0] : "📍 Localização";
  // A middle line that isn't the header and isn't the URL is the place name.
  const place = lines.find((l) => !l.startsWith("📍") && !/^https?:\/\//.test(l));
  return { header, place, url: m[0] };
}

/** Compact clickable location card (opens the pin / route in Google Maps). */
function LocationCard({
  header,
  place,
  url,
}: {
  header: string;
  place?: string;
  url: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-[210px] items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 transition-colors hover:bg-muted"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
        <MapPin className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-sm font-medium text-foreground">{header}</span>
        {place && (
          <span className="truncate text-xs text-muted-foreground">{place}</span>
        )}
        <span className="mt-0.5 text-xs font-medium text-emerald-600">
          Abrir no Google Maps
        </span>
      </span>
    </a>
  );
}

/** Compact card for a Pix copia-e-cola / boleto code with a copy button. */
function CopyCodeCard({ label, code }: { label: string; code: string }) {
  const preview = code.length > 44 ? `${code.slice(0, 44)}…` : code;
  return (
    <div className="min-w-[220px] max-w-[280px]">
      <p className="text-sm font-semibold text-foreground">📋 {label}</p>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
        {preview}
      </p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(code)
            .then(() => toast.success("Código copiado."))
            .catch(() => toast.error("Não foi possível copiar."));
        }}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
      >
        <Copy className="h-3.5 w-3.5" />
        Copiar código
      </button>
    </div>
  );
}

const DOC_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
};

/** Best filename for a document: the caption if it looks like a filename,
 *  else the URL's basename, else a generic name. */
function documentFilename(caption: string | undefined, url: string): string {
  if (caption && /\.[a-z0-9]{2,5}$/i.test(caption.trim())) return caption.trim();
  try {
    const base = new URL(url).pathname.split("/").pop();
    if (base) return decodeURIComponent(base);
  } catch {
    // relative/opaque URL — fall through
  }
  return caption?.trim() || "documento";
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return DOC_MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** A media message with no real caption stores a bare "[image]"/"[audio]"…
 *  placeholder in content_text (see lib/channels/inbound.ts). Don't render
 *  that as a caption/filename — return undefined so callers fall back. */
function realCaption(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return /^\[[a-zA-Z]+\]$/.test(text.trim()) ? undefined : text;
}

/** The caption line rendered UNDER a media/template bubble.
 *
 *  In a GROUP the ingestion prefixes "Author: " and, when there's no caption,
 *  a bare "[kind]" placeholder (see lib/channels/inbound.ts) — so a captionless
 *  image lands as "Fulano: [image]". `realCaption`'s bare-placeholder filter
 *  misses that (the prefix isn't bare), which is why the redundant "[image]"
 *  leaks into the bubble. Here we peel the author off first: a placeholder body
 *  → render just the colored author name (WhatsApp shows the sender above group
 *  media) and drop the "[image]"; a real caption → the normal colored render.
 *
 *  Non-group: the caption when it's real, nothing for a bare placeholder.
 *  Returns null when there's nothing worth showing. */
function captionNode(
  text: string | undefined,
  isGroup: boolean,
): ReactNode | null {
  if (isGroup) {
    const raw = text ?? "";
    if (!raw) return null;
    const m = raw.match(/^([^\n:]{1,40}): ([\s\S]*)$/);
    const author = m?.[1] ?? null;
    const body = m ? m[2] : raw;
    if (/^\[[a-zA-Z]+\]$/.test(body.trim())) {
      return author ? (
        <span className="font-semibold" style={{ color: groupColor(author) }}>
          {author}
        </span>
      ) : null;
    }
    return <GroupText text={raw} />;
  }
  return realCaption(text) ? <RichText text={text} /> : null;
}

interface MessageBubbleProps {
  message: Message;
  /** Pre-computed quote info for messages that reply to another. `parentId` is
   *  the quoted message's id — present when the original is somewhere in the
   *  loaded thread, so the quote can jump to it. */
  reply?: { authorLabel: string; preview: string; parentId?: string | null } | null;
  /** Jump-to-original handler for the reply quote (WhatsApp-style). Called with
   *  the quoted message's id when the user clicks the embedded quote. */
  onNavigateToParent?: (parentId: string) => void;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  /** Contact phone/name — lets a call-log card offer "ligar de volta". */
  contactPhone?: string | null;
  contactName?: string | null;
  /** Team members, for highlighting @mentions in an internal note. */
  mentionMembers?: MentionMember[];
  /** Group conversation → color the author prefix + @mentions (WhatsApp-style). */
  isGroup?: boolean;
  /** Canal da conversa — pra o cartão de contato abrir "Conversar" no canal certo. */
  channelId?: string;
  /** Fire a text reply — wired to a template's quick-reply button chips. */
  onQuickReply?: (text: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-400" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} indisponível</span>
    </div>
  );
}

/**
 * Full-screen image viewer. Opens when a message image is clicked; closes on
 * backdrop click, the X, or Escape. Also offers "open in new tab".
 */
function Lightbox({
  src,
  alt,
  onClose,
  kind = "image",
}: {
  src: string;
  alt: string;
  onClose: () => void;
  kind?: "image" | "video";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title="Abrir em nova aba"
        aria-label="Abrir em nova aba"
        className="absolute left-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <ExternalLink className="h-5 w-5" />
      </a>
      <button
        type="button"
        onClick={onClose}
        title="Fechar"
        aria-label="Fechar"
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="h-5 w-5" />
      </button>
      {kind === "video" ? (
        <video
          src={src}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
          className="max-h-[90vh] max-w-[90vw] rounded-lg"
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt={alt}
          onClick={(e) => e.stopPropagation()}
          className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        />
      )}
    </div>
  );
}

/** Inline video with a maximize button that opens it fullscreen — mirrors
 *  MediaImage (blob-loads proxy URLs so auth headers are sent). */
function MediaVideo({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let revoked: string | null = null;
    (async () => {
      if (!url) return;
      if (url.startsWith("/api/whatsapp/media/")) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error("Failed to load media");
          const blobUrl = URL.createObjectURL(await res.blob());
          revoked = blobUrl;
          setSrc(blobUrl);
        } catch {
          setError(true);
        } finally {
          setLoading(false);
        }
      } else {
        setSrc(url);
        setLoading(false);
      }
    })();
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [url]);

  if (error) return <MediaUnavailable label="Vídeo" />;
  if (loading || !src) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  return (
    <>
      <div className="group relative w-fit">
        <video src={src} controls className="max-h-64 max-w-60 rounded-lg" />
        <button
          type="button"
          onClick={() => setZoomed(true)}
          title="Ampliar"
          aria-label="Ampliar vídeo"
          className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
      {zoomed && (
        <Lightbox
          src={src}
          alt="Vídeo"
          kind="video"
          onClose={() => setZoomed(false)}
        />
      )}
    </>
  );
}

function MediaImage({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [zoomed, setZoomed] = useState(false);

  const loadImage = useCallback(async () => {
    if (!url) return;

    // Proxy URLs need auth fetch to create blob URL
    if (url.startsWith("/api/whatsapp/media/")) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        setSrc(blobUrl);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    } else {
      setSrc(url);
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    loadImage();
    return () => {
      if (src?.startsWith("blob:")) {
        URL.revokeObjectURL(src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadImage]);

  if (error) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <ImageOff className="h-8 w-8 text-muted-foreground" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-40 w-60 items-center justify-center rounded-lg bg-muted">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src ?? ""}
        alt={alt}
        onClick={() => setZoomed(true)}
        className="max-h-64 max-w-60 cursor-zoom-in rounded-lg object-cover transition-opacity hover:opacity-90"
        onError={() => setError(true)}
      />
      {zoomed && src && (
        <Lightbox src={src} alt={alt} onClose={() => setZoomed(false)} />
      )}
    </>
  );
}

/** WhatsApp "view once" media: keep it hidden behind a tap-to-reveal cover
 *  (the CRM stores it so an agent can re-open, unlike WhatsApp). */
function ViewOnceCover({
  kind,
  children,
}: {
  kind: "image" | "video";
  children: React.ReactNode;
}) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <>{children}</>;
  return (
    <button
      type="button"
      onClick={() => setRevealed(true)}
      className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/60 px-3 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <EyeOff className="h-4 w-4 shrink-0" />
      <span>
        {kind === "image" ? "Foto" : "Vídeo"} de visualização única — toque para
        ver
      </span>
    </button>
  );
}

function CallCard({
  call,
  contactPhone,
  contactName,
}: {
  call: ParsedCallLog;
  contactPhone?: string | null;
  contactName?: string | null;
}) {
  const missed = !call.answered;
  const canCallBack = !!contactPhone;
  return (
    <button
      type="button"
      disabled={!canCallBack}
      onClick={() =>
        contactPhone &&
        startOutboundCall(contactPhone, contactName ?? undefined)
      }
      title={canCallBack ? "Ligar de volta" : undefined}
      className={`flex w-full items-center gap-2.5 py-0.5 text-left text-sm ${
        canCallBack ? "cursor-pointer hover:opacity-80" : "cursor-default"
      }`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
          missed ? "bg-red-500/15 text-red-500" : "bg-emerald-500/15 text-emerald-600"
        }`}
      >
        {missed ? <PhoneMissed className="size-4" /> : <Phone className="size-4" />}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-medium">Ligação de voz</span>
        <span className="text-xs text-muted-foreground">
          {missed ? "Perdida" : formatCallDuration(call.durationSec)}
          {canCallBack ? " · toque para ligar" : ""}
        </span>
      </span>
    </button>
  );
}

function CallPermissionCard({ perm }: { perm: ParsedCallPermission }) {
  if (!perm.granted) {
    return (
      <div className="flex items-center gap-2.5 py-0.5 text-sm">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-500">
          <PhoneOff className="size-4" />
        </span>
        <span className="font-medium">Não autorizou ligações</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 py-0.5 text-sm">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
        <ShieldCheck className="size-4" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-medium">Autorizou você a ligar</span>
        <span className="text-xs text-muted-foreground">
          {perm.permanent
            ? "Permissão permanente"
            : perm.expiresAt
              ? `Pode ligar até ${formatDayMonth(perm.expiresAt)}`
              : "Permissão temporária"}
        </span>
      </span>
    </div>
  );
}

/** Body + a row of the template's buttons. A URL/CTA button ("Link da aula")
 *  renders as a link that opens the page — always, regardless of direction. A
 *  quick-reply ("Confirmar") is clickable only on an INBOUND message (when
 *  `onQuickReply` is set): clicking fires the reply immediately and the whole
 *  quick-reply row locks after one pick so a stray second click can't send
 *  twice. On an outbound echo, quick-replies render as static chips. */
function TemplateButtons({
  body,
  buttons,
  isGroup,
  onQuickReply,
}: {
  body: string;
  buttons: TemplateBtn[];
  isGroup?: boolean;
  onQuickReply?: (text: string) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <div>
      {body && (
        <p className="whitespace-pre-wrap break-words text-sm">
          {isGroup ? <GroupText text={body} /> : <RichText text={body} />}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {buttons.map((btn, i) => {
          if (btn.url) {
            // URL/CTA button → open the page (like tapping it in WhatsApp).
            return (
              <a
                key={i}
                href={btn.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition hover:bg-primary/20 active:scale-95"
              >
                <ExternalLink className="h-3 w-3" />
                {btn.label}
              </a>
            );
          }
          // Quick-reply → send the label as a reply (inbound only).
          if (!onQuickReply) {
            return (
              <span
                key={i}
                className="rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground"
              >
                {btn.label}
              </span>
            );
          }
          return (
            <button
              key={i}
              type="button"
              disabled={chosen !== null}
              onClick={() => {
                if (chosen) return;
                setChosen(btn.label);
                onQuickReply(btn.label);
              }}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition active:scale-95",
                chosen === btn.label
                  ? "border-primary bg-primary text-primary-foreground"
                  : chosen
                    ? "border-border bg-muted text-muted-foreground opacity-60"
                    : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
              )}
            >
              {btn.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MessageContent({
  message,
  contactPhone,
  contactName,
  isGroup,
  channelId,
  onQuickReply,
}: {
  message: Message;
  contactPhone?: string | null;
  contactName?: string | null;
  channelId?: string;
  isGroup?: boolean;
  onQuickReply?: (text: string) => void;
}) {
  // Deleted on WhatsApp → hide the original content, show the placeholder
  // (mirrors WhatsApp's own "Esta mensagem foi apagada").
  if (message.deleted_at) {
    return (
      <span className="flex items-center gap-1.5 text-sm italic text-muted-foreground">
        <Ban className="h-3.5 w-3.5 shrink-0" />
        Mensagem apagada
      </span>
    );
  }
  switch (message.content_type) {
    case "text": {
      const txt = message.content_text ?? "";
      const buttons = parseTemplateButtons(txt);
      if (buttons)
        return (
          <TemplateButtons
            body={buttons.body}
            buttons={buttons.buttons}
            isGroup={isGroup}
            // Clickable only on an INBOUND (customer) message — that's when the
            // agent is answering the received template's buttons.
            onQuickReply={
              message.sender_type === "customer" ? onQuickReply : undefined
            }
          />
        );
      if (txt.startsWith(PIX_PREFIX)) return <PixCard text={txt} />;
      if (txt.startsWith(CONTACT_PREFIX)) return <ContactCard text={txt} channelId={channelId} />;
      const copyCode = detectCopyCode(txt);
      if (copyCode) return <CopyCodeCard {...copyCode} />;
      const location = detectLocation(txt);
      if (location) return <LocationCard {...location} />;
      const callLog = parseCallLog(txt);
      if (callLog)
        return (
          <CallCard
            call={callLog}
            contactPhone={contactPhone}
            contactName={contactName}
          />
        );
      const perm = parseCallPermission(txt);
      if (perm) return <CallPermissionCard perm={perm} />;
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {isGroup ? (
            <GroupText text={message.content_text ?? ""} />
          ) : (
            <RichText text={message.content_text} />
          )}
        </p>
      );
    }

    case "image": {
      const cap = captionNode(message.content_text, !!isGroup);
      return (
        <div>
          {message.media_url ? (
            message.view_once ? (
              <ViewOnceCover kind="image">
                <MediaImage url={message.media_url} alt="Imagem" />
              </ViewOnceCover>
            ) : (
              <MediaImage url={message.media_url} alt="Imagem" />
            )
          ) : (
            <MediaUnavailable label="Imagem" />
          )}
          {cap != null && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{cap}</p>
          )}
        </div>
      );
    }

    case "video": {
      const videoEl = message.media_url ? (
        <MediaVideo url={message.media_url} />
      ) : null;
      const cap = captionNode(message.content_text, !!isGroup);
      return (
        <div>
          {videoEl ? (
            message.view_once ? (
              <ViewOnceCover kind="video">{videoEl}</ViewOnceCover>
            ) : (
              videoEl
            )
          ) : (
            <MediaUnavailable label="Vídeo" />
          )}
          {cap != null && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">{cap}</p>
          )}
        </div>
      );
    }

    case "audio":
      return (
        <div className="space-y-1.5">
          {message.media_url ? (
            <audio src={message.media_url} controls className="max-w-60" />
          ) : (
            <MediaUnavailable label="Áudio" />
          )}
          {message.transcription && (
            <div className="max-w-60 rounded-lg bg-muted/50 px-2.5 py-1.5">
              <p className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Sparkles className="h-3 w-3" />
                Transcrição
              </p>
              <p className="whitespace-pre-wrap text-sm leading-snug text-foreground/90">
                {message.transcription}
              </p>
            </div>
          )}
        </div>
      );

    case "document": {
      const cap = realCaption(message.content_text);
      // A caption that's a bare filename (no spaces, ends in an extension) is
      // the file's own name → use it as the card label. Anything else is a
      // real caption → keep the card compact and render the caption wrapped
      // BELOW it (instead of stretching it into a single overflowing line).
      // In a group the caption carries an "Author: " prefix (so it can never
      // look like a bare filename) — route it through captionNode instead, so
      // a captionless doc shows just the author and drops the "[document]".
      const isFilenameCaption =
        !isGroup &&
        !!cap &&
        /\.[a-z0-9]{2,5}$/i.test(cap.trim()) &&
        !/\s/.test(cap.trim());
      const label = isFilenameCaption ? cap!.trim() : "Documento";
      const caption = isGroup
        ? captionNode(message.content_text, true)
        : isFilenameCaption
          ? null
          : cap
            ? <RichText text={cap} />
            : null;
      if (!message.media_url) {
        return <MediaUnavailable label={label} />;
      }
      return (
        <div>
          <a
            href={message.media_url}
            target="_blank"
            rel="noopener noreferrer"
            draggable
            onDragStart={(e) => {
              // Let the user drag the document straight out to their desktop
              // (Chromium DownloadURL protocol: "mime:filename:absolute-url").
              const url = message.media_url!;
              const name = documentFilename(
                isFilenameCaption ? cap : undefined,
                url,
              );
              e.dataTransfer.setData(
                "DownloadURL",
                `${mimeFromName(name)}:${name}:${url}`,
              );
              e.dataTransfer.setData("text/uri-list", url);
            }}
            title="Abrir ou arrastar para baixar"
            className="flex max-w-full items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm hover:bg-muted"
          >
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </a>
          {caption != null && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {caption}
            </p>
          )}
        </div>
      );
    }

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            <LayoutTemplate className="h-3 w-3" />
            Template
          </span>
          {captionNode(message.content_text, !!isGroup) != null && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {captionNode(message.content_text, !!isGroup)}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Localização compartilhada"}</span>
        </div>
      );

    case "interactive": {
      // Customer tapped a reply button or list row on a message the bot
      // sent. We show the tapped option's title (already in content_text,
      // set by parseMessageContent in the webhook) with a small affordance
      // so agents reading the inbox can tell at a glance that this is a
      // tap rather than the customer typing the same words.
      return (
        <div className="flex flex-col gap-0.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            <CornerDownLeft className="h-3 w-3" />Resposta de botão</span>
          <p className="whitespace-pre-wrap break-words text-sm">
            {message.content_text || "[Resposta interativa]"}
          </p>
        </div>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.content_text || "[Tipo de mensagem não suportado]"}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  onNavigateToParent,
  reactions,
  currentUserId,
  onToggleReaction,
  contactPhone,
  contactName,
  mentionMembers,
  isGroup,
  channelId,
  onQuickReply,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  const time = format(new Date(message.created_at), "HH:mm");

  // Internal note: a team-only message on the thread (never sent to the
  // customer). Amber, right-aligned like an agent message, with a clear label.
  if (message.is_internal) {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-full rounded-2xl rounded-br-md border border-amber-400/40 bg-amber-100 px-3 py-2 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
            <Lock className="size-3" />
            Nota interna · só a equipe vê
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">
            <MentionText
              text={message.content_text ?? ""}
              members={mentionMembers ?? []}
            />
          </p>
          <div className="mt-1 flex justify-end">
            <span className="text-[10px] text-amber-700/80 dark:text-amber-400/70">
              {time}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Row alignment + width cap are owned by <MessageActions> so its hover
  // group matches the bubble's content area, not the full row.
  return (
    <div
      className={cn(
        "flex flex-col",
        isAgent ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3 py-2",
          isAgent
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-muted text-foreground",
        )}
      >
        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
            onNavigate={
              reply.parentId && onNavigateToParent
                ? () => onNavigateToParent(reply.parentId!)
                : undefined
            }
          />
        )}
        <MessageContent
          message={message}
          contactPhone={contactPhone}
          contactName={contactName}
          isGroup={isGroup}
          channelId={channelId}
          onQuickReply={onQuickReply}
        />
        <div
          className={cn(
            "mt-1 flex items-center gap-1",
            isAgent ? "justify-end" : "justify-start",
          )}
        >
          <span
            className={cn(
              "text-[10px]",
              // Outbound bubbles sit on the primary fill, so the
              // timestamp must read against that (not the neutral
              // foreground) — otherwise it goes low-contrast in light
              // mode. Inbound bubbles use the muted surface.
              isAgent ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {time}
          </span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>
      </div>
      {reactions && reactions.length > 0 && onToggleReaction && (
        <MessageReactions
          reactions={reactions}
          currentUserId={currentUserId}
          onToggle={onToggleReaction}
        />
      )}
    </div>
  );
}
