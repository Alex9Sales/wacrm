import { ImageResponse } from "next/og";

// Favicon: quadrado roxo + o símbolo da marca (o F de braços cortados
// na diagonal), o mesmo de `src/components/brand/fluxia-logo.tsx` e da
// sidebar. O path vive duplicado aqui de propósito: esta rota roda no
// runtime edge do Satori, que renderiza SVG mas não monta componentes
// React da aplicação. Mudou a marca, mude nos dois lugares.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#7c3aed", // primary (Hostinger-aligned purple)
          borderRadius: 6,
        }}
      >
        <svg width="20" height="20" viewBox="0 0 32 32" fill="#ffffff">
          <path d="M7.1 6.4h17.8l-3.2 4.4H7.1z" />
          <path d="M7.1 13.8h13.2l-3.2 4.4H7.1z" />
          <rect x="7.1" y="6.4" width="4.4" height="19.2" rx="2.2" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
