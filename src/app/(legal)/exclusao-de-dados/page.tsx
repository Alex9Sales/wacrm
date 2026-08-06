import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Instruções de Exclusão de Dados — FluxiaCRM',
  description:
    'Como solicitar a exclusão dos seus dados no FluxiaCRM (Sales Tecnologia), incluindo dados da integração com o WhatsApp Business Platform da Meta.',
};

export default function ExclusaoDeDadosPage() {
  return (
    <>
      <h1>Instruções de Exclusão de Dados</h1>
      <p className="updated">Última atualização: agosto de 2026</p>

      <p>
        A <strong>Sales Tecnologia</strong> (FluxiaCRM) respeita o seu direito de
        solicitar a exclusão dos seus dados pessoais, incluindo os dados tratados por
        meio da integração com a WhatsApp Business Platform da Meta. Esta página
        explica como fazer o pedido.
      </p>

      <h2>Como solicitar a exclusão</h2>
      <p>Você pode solicitar a exclusão dos seus dados de duas formas:</p>
      <ul>
        <li>
          <strong>Por e-mail:</strong> envie uma mensagem para{' '}
          <strong>suporte@salestecnologia.com.br</strong> com o assunto{' '}
          &quot;Exclusão de dados&quot;, informando o e-mail da conta e/ou o número de
          WhatsApp associado, para que possamos localizar e remover seus dados.
        </li>
        <li>
          <strong>Pela plataforma:</strong> administradores podem remover contatos,
          conversas e canais diretamente no FluxiaCRM, e podem encerrar a conta em
          Configurações.
        </li>
      </ul>

      <h2>O que é excluído</h2>
      <p>
        Mediante a solicitação, excluímos os dados pessoais associados à sua conta ou
        ao identificador informado — incluindo mensagens, contatos e credenciais de
        canais conectados — dos nossos sistemas de produção. Alguns registros podem
        ser retidos apenas pelo período e na medida exigidos por obrigação legal, e
        depois eliminados.
      </p>

      <h2>Prazo</h2>
      <p>
        Confirmamos o recebimento do pedido e concluímos a exclusão em até{' '}
        <strong>30 dias</strong>, salvo obrigação legal em contrário. Você receberá
        uma confirmação por e-mail quando a exclusão for concluída.
      </p>

      <h2>Desconexão do WhatsApp</h2>
      <p>
        Ao excluir um canal ou encerrar a conta, o FluxiaCRM deixa de estar inscrito
        na Conta do WhatsApp Business (WABA) do cliente e para de receber e armazenar
        novas mensagens daquele número.
      </p>

      <h2>Contato</h2>
      <p>
        Sales Tecnologia — FluxiaCRM · <strong>suporte@salestecnologia.com.br</strong>
      </p>
    </>
  );
}
