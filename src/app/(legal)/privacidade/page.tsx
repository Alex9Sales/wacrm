import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Política de Privacidade — FluxiaCRM',
  description:
    'Como o FluxiaCRM (Sales Tecnologia) coleta, usa, compartilha e protege seus dados, incluindo a integração com a WhatsApp Business Platform da Meta.',
};

export default function PrivacidadePage() {
  return (
    <>
      <h1>Política de Privacidade</h1>
      <p className="updated">Última atualização: agosto de 2026</p>

      <p>
        Esta Política de Privacidade descreve como a <strong>Sales Tecnologia</strong>{' '}
        (&quot;FluxiaCRM&quot;, &quot;nós&quot;) coleta, usa, compartilha e protege
        informações no âmbito do FluxiaCRM — uma plataforma web de atendimento ao
        cliente (CRM) para pequenas e médias empresas, com integração ao WhatsApp.
      </p>

      <h2>1. Quem somos</h2>
      <p>
        O FluxiaCRM é operado pela Sales Tecnologia. Para questões de privacidade,
        entre em contato em <strong>servicos@salestecnologia.com.br</strong>.
      </p>

      <h2>2. Dados que coletamos</h2>
      <ul>
        <li>
          <strong>Dados da conta:</strong> nome, e-mail e credenciais dos usuários da
          empresa que utilizam a plataforma.
        </li>
        <li>
          <strong>Dados de contatos e conversas:</strong> quando uma empresa conecta
          seu próprio número de WhatsApp ao FluxiaCRM, recebemos e armazenamos as
          mensagens trocadas entre a empresa e seus clientes (texto, mídia e
          metadados como status de entrega/leitura), para exibi-las na caixa de
          entrada compartilhada da equipe.
        </li>
        <li>
          <strong>Dados técnicos:</strong> registros de acesso e uso necessários para
          operar e proteger o serviço.
        </li>
      </ul>

      <h2>3. Integração com a WhatsApp Business Platform (Meta)</h2>
      <p>
        Uma empresa conecta seu próprio número do WhatsApp Business à sua própria
        conta no FluxiaCRM por meio do fluxo de <strong>Cadastro Incorporado
        (Embedded Signup)</strong> da Meta, incluindo a modalidade de{' '}
        <strong>Coexistência</strong>. Usamos as permissões concedidas exclusivamente
        para:
      </p>
      <ul>
        <li>
          receber mensagens de clientes por webhook (e, na Coexistência, os
          <em> smb_message_echoes</em>) e exibi-las em uma caixa de entrada compartilhada;
        </li>
        <li>
          enviar respostas escritas pelos atendentes da empresa via WhatsApp Cloud API;
        </li>
        <li>
          ler o status de entrega/leitura para mostrar o estado de cada mensagem;
        </li>
        <li>
          ler e gerenciar templates de mensagem e o perfil comercial da conta conectada.
        </li>
      </ul>
      <p>
        Esses dados são usados <strong>apenas</strong> para números que a empresa
        conecta explicitamente à sua própria conta, e sempre para responder a
        clientes que iniciaram a conversa com a empresa. Os dados do WhatsApp são
        tratados de acordo com os Termos da Meta para o WhatsApp Business e a
        Política da Plataforma Meta.
      </p>

      <h2>4. Como usamos os dados</h2>
      <p>
        Usamos os dados para prestar e melhorar o serviço de atendimento: exibir
        conversas, permitir respostas, organizar contatos e negócios, gerar
        relatórios para a própria empresa e garantir a segurança da plataforma. Não
        vendemos seus dados.
      </p>

      <h2>5. Compartilhamento</h2>
      <p>
        Compartilhamos dados apenas com: (a) a <strong>Meta</strong>, na medida
        necessária para operar a integração do WhatsApp; (b) provedores de
        infraestrutura que hospedam o serviço, sob obrigações de confidencialidade;
        e (c) quando exigido por lei. Cada empresa acessa somente os dados da sua
        própria conta.
      </p>

      <h2>6. Retenção e segurança</h2>
      <p>
        Retemos os dados enquanto a conta estiver ativa ou conforme necessário para
        cumprir obrigações legais. Credenciais e tokens sensíveis são armazenados de
        forma criptografada, e o acesso é restrito por conta.
      </p>

      <h2>7. Seus direitos (LGPD)</h2>
      <p>
        Você pode solicitar acesso, correção, portabilidade ou{' '}
        <strong>exclusão</strong> dos seus dados. Consulte nossas{' '}
        <a href="/exclusao-de-dados">Instruções de Exclusão de Dados</a> ou escreva
        para <strong>servicos@salestecnologia.com.br</strong>.
      </p>

      <h2>8. Cookies</h2>
      <p>
        Usamos cookies estritamente necessários para autenticação e funcionamento da
        plataforma.
      </p>

      <h2>9. Alterações</h2>
      <p>
        Podemos atualizar esta política. Alterações relevantes serão comunicadas
        pelos canais da plataforma.
      </p>

      <h2>10. Contato</h2>
      <p>
        Sales Tecnologia — FluxiaCRM · <strong>servicos@salestecnologia.com.br</strong>
      </p>
    </>
  );
}
