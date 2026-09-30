# Agente de clínica com vários profissionais — como montar o prompt

Guia para quem implanta (Rafael). Escrito em 30/09/2026, a partir da clínica da
Dra. Joyce Martins Odontologia: 10 profissionais, 10 agendas, uma IA.

---

## 1. O que o CRM faz sozinho, e o que depende de você

**Sozinho, sem escrever uma linha de prompt:**

| O CRM faz | Como |
|---|---|
| Descobre as agendas do Google | a cada 5 min, sozinho; agenda nova aparece sem reconectar nada |
| Importa os compromissos | janela de 7 dias atrás até 60 dias à frente |
| Liga o paciente ao compromisso | pelo **telefone** que o software da clínica escreve na descrição |
| Manda a confirmação da consulta | pelos degraus do Follow-up do agente |
| Avisa quando um lembrete **não** conseguiu sair | no próprio compromisso, na tela da Agenda |
| Mostra à IA quem está ocupado, **por profissional** | só quando a conta tem mais de uma agenda |

**Depende de você, no prompt:** ensinar a IA *quando* marcar, *com quem*, em
*quais horários* e *quando parar e chamar gente*.

---

## 2. A regra que muda tudo: uma agenda por profissional

Quando a conta tem **mais de uma agenda**, o CRM injeta no prompt, a cada
resposta, um bloco assim:

```
- Dra. Bruna Diodatti — ocupado: qua 01/10 10:00–11:00; qua 01/10 14:00–15:00
- Dr. Lucas Pracchia — sem compromissos no período
- Dra. Juliane Tavares — ocupado: qui 02/10 09:00–10:00
```

Cada agenda é **independente**: horário ocupado com uma dentista não bloqueia a
mesma hora com outro. Antes disso existir, a lista de ocupados era uma só, da
conta inteira, e um compromisso de qualquer profissional fechava aquele horário
para todos.

⚠️ **Conta com uma agenda só não recebe esse bloco.** É de propósito: seria peso
no prompt sem informação nova. Se a clínica que você está montando tem um
profissional só, ignore esta seção inteira.

### Como a IA marca na agenda certa

O comando ganhou um **terceiro campo**:

```
[[AGENDAR:AAAA-MM-DDTHH:MM|<título> · <Nome do paciente>|<Nome do profissional>]]
```

Exemplo real:

```
[[AGENDAR:2026-10-01T10:00|Avaliação · Ana Souza|Dra. Bruna Diodatti]]
```

- O nome do profissional tem que ser **copiado exatamente como aparece na lista**
  que o CRM injeta (que é o nome da agenda no Google).
- **Sem o terceiro campo**, a consulta cai na agenda padrão da conta e alguém da
  recepção vai ter que mover na mão.
- O CRM aceita variações razoáveis: "Dra. Bruna", "bruna diodatti" e
  "DOUTORA BRUNA DIODATTI" acham a mesma agenda. Título, acento e espaço
  sobrando não atrapalham.
- **Se duas agendas puderem ser a mesma pessoa** (duas "Simone" na clínica), o
  CRM **não chuta**: manda para a agenda padrão e registra no log. Marcar na
  agenda errada põe o paciente na cadeira do dentista errado, e isso só aparece
  no dia da consulta.

**O que escrever no prompt** (copie e adapte):

```
VOCÊ MARCA COM QUALQUER PROFISSIONAL DA CLÍNICA.

O CRM te mostra, acima, a lista das agendas — uma por profissional — com os
horários JÁ OCUPADOS de cada um. Cada agenda é independente: horário ocupado
com um profissional NÃO impede o mesmo horário com outro.

- Pediram um profissional pelo nome? Olhe a linha DELE e ofereça só horários que
  não batem com o que já está ocupado ali.
- Não tem preferência? Ofereça o horário mais próximo de quem estiver livre, e
  diga com quem é: "tenho quinta às 10h com a Dra. Bruna".
- Nunca ofereça horário que aparece como ocupado na linha daquele profissional.
- Nunca invente profissional que não está na lista. Pediram alguém de fora da
  lista? Aí sim passe pra recepção.

Ao marcar, escreva o nome do profissional no TERCEIRO campo, exatamente como
aparece na lista:
[[AGENDAR:AAAA-MM-DDTHH:MM|<título> · <Nome completo do paciente>|<Profissional>]]
```

### ⚠️ O que o CRM **não** sabe (e você precisa escrever)

O CRM mostra quando cada profissional está **ocupado**. Ele **não** sabe o
**expediente** de cada um — que dias e horas cada profissional atende.

Sem isso no prompt, a IA pode oferecer terça de manhã para um dentista que só
atende à tarde: o horário está "livre" porque simplesmente não existe.

**Escreva o expediente de cada profissional**, assim:

```
QUEM ATENDE QUANDO:
- Dra. Joyce Martins — seg a sex à tarde (13h–19h); quarta também de manhã (9h–11h)
- Dra. Bruna Diodatti — ter e qui, 9h–17h
- Dr. Lucas Pracchia — seg, qua e sex, 14h–20h
(…um por linha, com o nome EXATAMENTE como está na agenda do Google)

Nunca ofereça horário fora do expediente do profissional, mesmo que a agenda
dele esteja livre naquele horário.
```

Peça essa lista à clínica **antes** de ligar a IA. É o dado que falta com mais
frequência, e é o que faz a IA marcar horário que não existe.

---

## 3. Quando a IA para e chama gente

Toda clínica tem uma lista de "isso não é com a IA". A armadilha é o tamanho
dela: quanto maior, mais a IA vira uma secretária eletrônica que só anota
recado, e o paciente sente que ninguém está cuidando dele.

**Deixe com a IA** (ela resolve sozinha): marcar, remarcar, preço de tabela,
objeção ("vou pensar", "tá caro", "moro longe", "tenho medo"), endereço,
horário, o que a consulta inclui.

**Passe para a recepção** só o que realmente não é dela:
urgência/dor · dúvida clínica e pós-operatório · negociação e desconto de
tratamento · financeiro (pagamento, PIX, nota, reembolso) · documento e atestado
· reclamação · pedido explícito de falar com uma pessoa · pergunta que não tem
resposta no prompt.

E escreva a regra de que **passar objeção não vale**:

```
"Várias idas e vindas sem avanço" não é motivo pra passar pra recepção: é
motivo pra mudar de ângulo.
```

### A regra que faltava: religaram a IA = é pra continuar

Cena real, de hoje, na clínica da Dra. Joyce: uma atendente estava conduzindo o
agendamento pelo WhatsApp; no meio, alguém religou a IA na conversa; a IA entrou
e disse *"vou encaminhar para nossa recepção"* — para a recepção que já estava
falando com a paciente.

Coloque isto no prompt, junto da regra de "humano assumiu, você para":

```
RELIGARAM VOCÊ? ENTÃO É PRA VOCÊ CONTINUAR. Se alguém da equipe reativou você
numa conversa em andamento, isso é um pedido explícito pra você assumir dali em
diante. Leia o histórico, entenda o que já foi combinado e SIGA DE ONDE PAROU —
inclusive marcando, se era isso que estava sendo tratado. Proibido, nesse caso,
dizer que vai passar pra recepção uma coisa que a própria recepção já estava
resolvendo com o paciente.
```

---

## 4. Lembretes de consulta

Configure em **Agentes → Follow-up → Lembretes de reunião**. Cada degrau é
ancorado no horário da consulta.

O que funciona bem numa clínica:

| Degrau | Para quê |
|---|---|
| 1 dia antes | confirmar, e dar tempo de remarcar se não puder |
| 12 horas antes | chega de manhã no dia (o sistema segura fora do horário comercial) |

**Não existe "mandar às 8h da manhã"** — o degrau é sempre relativo ao horário da
consulta. Para cair de manhã, use 12h antes: como o envio respeita o horário
comercial, o que venceria de madrugada é segurado e sai na abertura.

⚠️ **Canal oficial (Meta) precisa de template aprovado** para lembrete fora da
janela de 24h. Escolha o template no próprio degrau. Sem ele, o lembrete fica
travado e o compromisso mostra o motivo na Agenda. Em canal WAHA isso não se
aplica: manda texto normal a qualquer hora.

---

## 5. Checklist de implantação

Antes de ligar a IA de uma clínica nova:

- [ ] Google conectado, com **permissão de editar** nas agendas dos profissionais
      (agenda compartilhada só como leitura **não aparece** no CRM)
- [ ] Conferir na Agenda do CRM se todas as agendas apareceram
- [ ] Lista de **expediente por profissional** escrita no prompt
- [ ] Tabela de preços e o que cada consulta inclui
- [ ] Endereço, ponto de referência, estacionamento
- [ ] Feriados do período escritos no prompt (o modelo não sabe)
- [ ] Lista curta de "passar pra recepção"
- [ ] Degraus de lembrete configurados (e template, se o canal for oficial)
- [ ] ⚠️ **Perguntar se o software da clínica já manda lembrete próprio** — o
      Capim manda, e o paciente acaba recebendo dois avisos
- [ ] Testar: marcar uma consulta de mentira com dois profissionais diferentes e
      conferir em qual agenda cada uma caiu

---

## 6. Armadilhas que já custaram caro

**O telefone é a identidade, o nome não é.** O vínculo entre o compromisso e o
paciente é feito pelo telefone que o software da clínica escreve na descrição do
evento. Medido na base da Dra. Joyce: por telefone, 28 de 31 consultas casaram e
nenhuma ficou ambígua; por nome, 16 de 51, **com** ambiguidade — a recepção salva
a mesma pessoa como "Ana Pereira", "Ana Maria" e "Ana irmã do Sérgio", e existem
dois "Jose Carlos Silva" idênticos no cadastro. Se o software não escreve o
telefone, o lembrete não sai — e a solução é preencher o cadastro lá, não afrouxar
a regra aqui.

**Consulta sem paciente ligado aparece na Agenda com aviso.** Bloqueio de agenda
("não agendar", almoço) não aparece — seriam 453 alertas inúteis para 118
consultas nessa clínica.

**Cópia manual precisa de 2 dias de folga.** Se a agenda vem de um software sem
integração e alguém copia à mão, o que for copiado com menos de 24h de
antecedência não avisa ninguém: o primeiro degrau já venceu.

**"Desconectar" não é "sincronizar".** O botão Desconectar do Google para a
sincronização. Para atualizar agora, use **Sincronizar**.
