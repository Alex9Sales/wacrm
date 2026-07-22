import { type ReactNode } from "react";

import { renderRichText } from "./rich-text";

// ============================================================
// WhatsApp-style coloring for GROUP messages: the author name prefix ("Fulano:")
// and @mentions get a per-participant color so you can scan who said what — like
// WhatsApp, instead of everything in one flat color. The color is a stable hash
// of the name, from a palette tuned to stay legible on light AND dark bubbles.
// ============================================================

// ~14 distinct hues, mid-saturation/lightness so they read on both themes.
const PALETTE = [
  "#d6336c", "#e8590c", "#c9a227", "#2f9e44", "#0ca678", "#1098ad",
  "#1c7ed6", "#4263eb", "#7048e8", "#9c36b5", "#e64980", "#f76707",
  "#0b7285", "#5c940d",
];

/** Stable color for a participant name (same name → same color, always). */
export function groupColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** The "Author:" prefix a group message is ingested with, or null if absent.
 *  Shared by GroupText (colors it) and the bubble avatar (initial + color). */
export function parseGroupAuthor(text: string): string | null {
  const m = (text ?? "").match(/^([^\n:]{1,40}): ([\s\S]*)$/);
  return m ? m[1] : null;
}

// @mention token: "@" + letters/digits/._- (stops at space/punctuation). The
// negative lookbehind keeps it from matching the "@" inside e.g. an email.
const MENTION_SRC = "(?<!\\S)@[\\p{L}\\p{N}._-]+";

/** Render a group message: color the "Author:" prefix + @mentions, pass the
 *  rest through the normal rich-text renderer (links + *bold* etc.). */
export function GroupText({ text }: { text: string }): ReactNode {
  if (!text) return null;

  // Split an author prefix "Name: rest" (the ingestion prefixes group messages).
  const author = parseGroupAuthor(text);
  const body = author ? text.slice(author.length + 2) : text;

  const out: ReactNode[] = [];
  if (author) {
    out.push(
      <span key="au" className="font-semibold" style={{ color: groupColor(author) }}>
        {author}
      </span>,
    );
    out.push(<span key="colon">: </span>);
  }

  let last = 0;
  let i = 0;
  let mm: RegExpExecArray | null;
  const re = new RegExp(MENTION_SRC, "gu");
  while ((mm = re.exec(body))) {
    if (mm.index > last) {
      out.push(<span key={`t${i}`}>{renderRichText(body.slice(last, mm.index))}</span>);
    }
    const tok = mm[0];
    out.push(
      <span key={`m${i}`} className="font-medium" style={{ color: groupColor(tok.slice(1)) }}>
        {tok}
      </span>,
    );
    last = mm.index + tok.length;
    i++;
  }
  if (last < body.length) {
    out.push(<span key="end">{renderRichText(body.slice(last))}</span>);
  }
  return <>{out}</>;
}
