// ============================================================
// 📞 Ligar o compromisso do Google ao paciente — PELO TELEFONE.
//
// 30/09 (Dra. Joyce). Os pacientes dela não recebiam a confirmação da consulta.
// A causa não era a que parecia: o evento chega do Google **sem contato**, e sem
// contato o lembrete não sabe para quem mandar. Eram 157 de 158.
//
// A agenda dela vem do Capim (o software da clínica, que não tem API) e o Capim
// escreve o telefone na descrição do evento:
//
//   Paciente: Mateus Menegat Vanzin
//   Telefone: (54) 9917-1108
//   Status no Capim: Confirmado
//   Importado do Capim (id 28020374)
//
// Foi a própria Joyce quem apontou o caminho, reclamando dos nomes: *"a mulher
// tem um único nome e um único sobrenome, qual é a dificuldade de copiar o nome
// completo… se usar como critério o primeiro nome e o número do telefone, aí vai
// ficar lindo"*. Ela está certa sobre o telefone, e por um motivo que vale além
// da clínica dela: nome é apelido, telefone é identidade.
//
// ⚠️ POR QUE NÃO CASAR POR NOME. Medido na base dela: por telefone, 28 das 31
// consultas reais casam e NENHUMA fica ambígua; por nome, 16 de 51 e com
// ambiguidade — o Capim guarda "Ana Maria Pereira Pinto" e a recepção salvou
// "Ana Pereira", "Ana Maria" e "Ana irmã do Sérgio" como contatos diferentes.
// Num cadastro de 5.913 pacientes, casar por nome é mandar lembrete de consulta
// para a pessoa errada — dano pior do que não mandar nada.
//
// Sem 'server-only': o worker do sync alcança este arquivo.
// ============================================================

/**
 * O telefone escrito na descrição do evento, só dígitos.
 *
 * Aceita a linha "Telefone: (54) 9917-1108" em qualquer posição do texto e com
 * qualquer máscara. Devolve null quando não há telefone plausível — melhor
 * evento órfão do que evento ligado a quem não é.
 */
export function phoneFromDescription(description: string | null | undefined): string | null {
  const texto = description ?? ''
  if (!texto) return null
  const m = texto.match(/telefone\s*:\s*([^\n\r]+)/i)
  if (!m) return null
  const digitos = m[1].replace(/\D/g, '')
  // 10 = DDD + 8 (fixo ou celular antigo). Menos que isso não identifica
  // ninguém; mais que 13 é lixo colado (dois números na mesma linha).
  return digitos.length >= 10 && digitos.length <= 13 ? digitos : null
}

/**
 * O compromisso é uma CONSULTA DE ALGUÉM, e não um bloqueio de agenda?
 *
 * A diferença importa na hora de avisar: numa agenda de clínica, a maioria
 * esmagadora dos compromissos não é paciente. Na da Dra. Joyce são 453 bloqueios
 * ("não agendar", horário reservado, almoço, sem título) para 118 consultas.
 * Marcar todos como "ninguém será avisado" encheria a tela de alerta falso, e
 * alerta que grita à toa deixa de ser lido.
 *
 * Mas a consulta órfã — uma pessoa de verdade com hora marcada e sem ninguém
 * ligado a ela — precisa aparecer: é exatamente o caso que passa despercebido
 * até o paciente não chegar. O Capim escreve "Paciente: <nome>" na descrição, e
 * é isso que separa um do outro.
 */
export function pareceConsultaDeAlguem(description: string | null | undefined): boolean {
  return /(^|\n)\s*paciente\s*:\s*\S/i.test(description ?? '')
}

/**
 * A chave de comparação: os 8 últimos dígitos.
 *
 * O Capim guarda "(54) 9917-1108" e o CRM guarda "5554999171108" — o mesmo
 * telefone, com e sem país, com e sem o 9º dígito. Comparar os 8 finais é o que
 * o resto do projeto já faz (`lib/contacts/dedupe.ts`), e é o único pedaço que
 * sobrevive a todas as grafias.
 */
export function phoneKey(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '')
  return d.length >= 8 ? d.slice(-8) : null
}
