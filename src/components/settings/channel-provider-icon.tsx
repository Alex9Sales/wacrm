import { cn } from '@/lib/utils';

// ============================================================
// Ícone do provedor com a COR OFICIAL da marca — usado no picker de
// "Adicionar canal" (e reutilizável). Um quadradinho arredondado com o
// fundo da marca + o glifo branco. lucide 1.22 não traz ícones de marca,
// então os glifos são SVG inline (paths estilo simple-icons).
//   • WhatsApp (meta/waha/evolution/evogo) → verde #25D366
//   • Instagram → degradê amarelo→rosa→azul
//   • Messenger → degradê azul→roxo
// ============================================================

const WHATSAPP_PATH =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.334.101 11.892c0 2.096.549 4.14 1.595 5.945L0 24l6.335-1.652a12.062 12.062 0 005.71 1.447h.005c6.585 0 11.945-5.335 11.948-11.894 0-3.176-1.24-6.165-3.487-8.411';

const MESSENGER_PATH =
  'M12 0C5.373 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.652V24l4.088-2.242c1.092.301 2.246.464 3.443.464 6.627 0 12-4.975 12-11.111C24 4.974 18.627 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26L10.732 8l3.131 3.259L19.752 8l-6.561 6.963z';

function FilledGlyph({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  );
}

/** Câmera do Instagram (stroke branco por cima do degradê). */
function InstagramCamera({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

export function ChannelProviderIcon({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  const box = cn('flex shrink-0 items-center justify-center rounded-lg text-white', className);
  const glyph = 'h-[62%] w-[62%]';

  if (provider === 'instagram') {
    return (
      <span className={cn(box, 'bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5]')}>
        <InstagramCamera className={glyph} />
      </span>
    );
  }
  if (provider === 'messenger') {
    return (
      <span className={cn(box, 'bg-gradient-to-br from-[#00C6FF] via-[#0068FF] to-[#A033FF]')}>
        <FilledGlyph path={MESSENGER_PATH} className={glyph} />
      </span>
    );
  }
  if (provider === 'email') {
    return (
      <span className={cn(box, 'bg-red-500')}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={glyph}
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      </span>
    );
  }
  // meta + waha + evolution + evogo → todos são WhatsApp (verde oficial).
  return (
    <span className={cn(box, 'bg-[#25D366]')}>
      <FilledGlyph path={WHATSAPP_PATH} className={glyph} />
    </span>
  );
}
