import { Fragment, type ReactNode } from "react";

// ============================================================
// WhatsApp-style rich text for chat bubbles: clickable links + inline
// formatting (*bold*, _italic_, ~strike~, `mono`). Builds React nodes (never
// dangerouslySetInnerHTML) so message content can't inject markup. Links open
// in a new tab; colors are inherited so they stay legible on any bubble.
// ============================================================

const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
const FMT_RE = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;

/** Apply inline WhatsApp formatting to a plain (link-free) text segment. */
function formatInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  FMT_RE.lastIndex = 0;
  while ((m = FMT_RE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const inner = token.slice(1, -1);
    const key = `${keyPrefix}-f${i++}`;
    switch (token[0]) {
      case "*":
        nodes.push(<strong key={key}>{inner}</strong>);
        break;
      case "_":
        nodes.push(<em key={key}>{inner}</em>);
        break;
      case "~":
        nodes.push(<del key={key}>{inner}</del>);
        break;
      default:
        nodes.push(
          <code key={key} className="rounded bg-black/10 px-1 font-mono text-[0.9em]">
            {inner}
          </code>,
        );
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Render `text` with links + inline formatting as React nodes. */
export function renderRichText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) {
      out.push(...formatInline(text.slice(last, m.index), `t${i}`));
    }
    let url = m[0];
    // Trailing punctuation is almost never part of the URL.
    let trail = "";
    const tm = /[.,!?)\]}'"]+$/.exec(url);
    if (tm) {
      trail = tm[0];
      url = url.slice(0, url.length - trail.length);
    }
    const href = url.startsWith("http") ? url : `https://${url}`;
    out.push(
      <a
        key={`u${i}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="underline underline-offset-2 hover:opacity-80 break-all"
      >
        {url}
      </a>,
    );
    if (trail) out.push(trail);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(...formatInline(text.slice(last), `t${i}`));
  return out;
}

/** Convenience wrapper component. */
export function RichText({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <Fragment>{renderRichText(text)}</Fragment>;
}
