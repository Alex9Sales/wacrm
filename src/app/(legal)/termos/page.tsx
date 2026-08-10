import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Termos de Serviço — FluxiaCRM',
  description:
    'Termos de Serviço do FluxiaCRM (Sales Tecnologia), plataforma de atendimento com integração ao WhatsApp Business Platform.',
};

export default function TermosPage() {
  return (
    <>
      <h1>Termos de Serviço</h1>
      <p className="updated">Última atualização: agosto de 2026</p>

      <p>
        Estes Termos de Serviço regem o uso do <strong>FluxiaCRM</strong>, plataforma
        de atendimento ao cliente operada pela <strong>Sales Tecnologia</strong>. Ao
        criar uma conta ou usar o serviço, você concorda com estes Termos.
      </p>

      <h2>1. O serviço</h2>
      <p>
        O FluxiaCRM é uma plataforma web que permite a empresas centralizar o
        atendimento a seus clientes, incluindo a conexão do próprio número de
        WhatsApp Business para receber e responder mensagens em uma caixa de entrada
        compartilhada, organizar contatos, funis de vendas e tarefas.
      </p>

      <h2>2. Conta e responsabilidades</h2>
      <ul>
        <li>
          Você é responsável por manter a confidencialidade das suas credenciais e
          por toda atividade realizada na sua conta.
        </li>
        <li>
          Você declara ter autorização para conectar os números de WhatsApp e tratar
          os dados dos contatos que insere na plataforma.
        </li>
      </ul>

      <h2>3. Uso aceitável</h2>
      <p>
        Você concorda em usar o FluxiaCRM em conformidade com a legislação aplicável
        e com as políticas da Meta/WhatsApp, incluindo a Política de Negócios do
        WhatsApp e a Política da Plataforma Meta. É proibido usar o serviço para spam,
        mensagens não solicitadas em massa, conteúdo ilícito ou qualquer uso que viole
        direitos de terceiros.
      </p>

      <h2>4. Integração com o WhatsApp oficial</h2>
      <p>
        Ao conectar um número via a API oficial (WhatsApp Business Platform), a
        empresa cliente permanece <strong>proprietária</strong> da sua Conta do
        WhatsApp Business (WABA), do número e do respectivo meio de pagamento junto à
        Meta. As tarifas de conversas cobradas pela Meta são de responsabilidade da
        empresa proprietária da conta. O FluxiaCRM atua como provedor de tecnologia
        (Tech Provider) para intermediar o atendimento.
      </p>

      <h2>5. Integração com o Google Calendar</h2>
      <p>
        A conexão com o Google Calendar é <strong>opcional</strong> e feita pelo
        próprio usuário na seção Agenda, por meio do login seguro do Google (OAuth).
        Ao conectar, você autoriza o FluxiaCRM a ler e a gerenciar (criar, editar e
        remover) eventos dos seus calendários, apenas para manter a Agenda do
        FluxiaCRM e o Google Calendar sincronizados. Você pode revogar o acesso a
        qualquer momento, desconectando o Google na Agenda ou nas configurações da sua
        Conta do Google. O tratamento desses dados segue a nossa{' '}
        <a href="/privacidade">Política de Privacidade</a> e a Política de Dados de
        Usuário dos Serviços de API do Google, incluindo os requisitos de Uso
        Limitado.
      </p>

      <h2>6. Propriedade intelectual</h2>
      <p>
        O software e a marca FluxiaCRM pertencem à Sales Tecnologia. Os dados de
        atendimento inseridos por cada empresa permanecem de titularidade da
        respectiva empresa.
      </p>

      <h2>7. Disponibilidade e limitação de responsabilidade</h2>
      <p>
        O serviço é fornecido &quot;no estado em que se encontra&quot;. Empregamos
        esforços razoáveis para manter a plataforma disponível e segura, mas não
        garantimos operação ininterrupta. Na máxima extensão permitida por lei, a
        Sales Tecnologia não se responsabiliza por danos indiretos decorrentes do uso
        ou indisponibilidade do serviço.
      </p>

      <h2>8. Rescisão</h2>
      <p>
        Você pode encerrar sua conta a qualquer momento. Podemos suspender ou
        encerrar contas que violem estes Termos ou as políticas da Meta/WhatsApp.
        Após o encerramento, os dados podem ser excluídos conforme nossas{' '}
        <a href="/exclusao-de-dados">Instruções de Exclusão de Dados</a>.
      </p>

      <h2>9. Privacidade</h2>
      <p>
        O tratamento de dados é descrito na nossa{' '}
        <a href="/privacidade">Política de Privacidade</a>.
      </p>

      <h2>10. Lei aplicável</h2>
      <p>
        Estes Termos são regidos pelas leis do Brasil.
      </p>

      <h2>11. Contato</h2>
      <p>
        Sales Tecnologia — FluxiaCRM · <strong>servicos@salestecnologia.com.br</strong>
      </p>
    </>
  );
}
