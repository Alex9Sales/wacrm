import { toast } from 'sonner';

import { sendCsatSurvey } from '@/app/(dashboard)/inbox/actions';

// ============================================================
// Aviso pós-fechamento da pesquisa de satisfação (CSAT). Ao fechar uma
// conversa, o CRM NÃO envia a pesquisa sozinho — pergunta ao atendente. Esta
// helper mostra o aviso "Enviar / Agora não" quando `offerCsat` (a conta tem
// CSAT ligado). Chamada pelos pontos que fecham a conversa.
// ============================================================

export function promptCsatOnClose(
  offerCsat: boolean,
  conversationId: string,
): void {
  if (!offerCsat) return;
  toast('Enviar pesquisa de satisfação para o cliente?', {
    duration: 12000,
    action: {
      label: 'Enviar',
      onClick: () => {
        void sendCsatSurvey(conversationId)
          .then(() => toast.success('Pesquisa de satisfação enviada.'))
          .catch(() => toast.error('Falha ao enviar a pesquisa.'));
      },
    },
    cancel: { label: 'Agora não', onClick: () => {} },
  });
}
