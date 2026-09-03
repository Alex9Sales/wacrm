import { describe, expect, it } from 'vitest'

import { parseCsv, parseCsvRows, parseXlsx, toCsv } from './sheet'

describe('parseCsv', () => {
  it('lê CSV com vírgula, aspas e quebra de linha dentro de aspas', () => {
    const rows = parseCsv('Nome,Telefone,Obs\n"Silva, João",67999990000,"linha 1\nlinha 2"\n')
    expect(rows).toEqual([{ Nome: 'Silva, João', Telefone: '67999990000', Obs: 'linha 1\nlinha 2' }])
  })

  it('detecta ponto-e-vírgula (Excel em português) e tira o BOM', () => {
    const rows = parseCsv('﻿Nome;Preço\nGás P13;120,50\n')
    expect(rows).toEqual([{ Nome: 'Gás P13', Preço: '120,50' }])
  })

  it('aspas duplicadas viram uma aspa; linha em branco é pulada; célula faltando vira vazio', () => {
    const rows = parseCsv('a,b\n"diz ""oi""",1\n\n,\nx\n')
    expect(rows).toEqual([
      { a: 'diz "oi"', b: '1' },
      { a: 'x', b: '' },
    ])
  })

  it('parseCsvRows respeita separador explícito', () => {
    expect(parseCsvRows('a\tb\r\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('toCsv', () => {
  it('escapa vírgula/aspas e põe BOM', () => {
    const csv = toCsv(['Nome', 'Obs'], [['Silva, João', 'diz "oi"']])
    expect(csv).toBe('﻿Nome,Obs\r\n"Silva, João","diz ""oi"""')
  })
})

describe('parseXlsx (exceljs)', () => {
  it('lê cabeçalho, número, data, fórmula e pula linha em branco', async () => {
    const { Workbook } = await import('exceljs')
    const wb = new Workbook()
    const ws = wb.addWorksheet('Contatos')
    ws.addRow(['Nome', 'Telefone', 'Nascimento', 'Preço', 'Total', ''])
    ws.addRow(['Cei', 67999990000, new Date(Date.UTC(1990, 4, 17)), 120.5, { formula: 'D2*2', result: 241 }])
    ws.addRow([])
    ws.addRow(['Construsul', '(67) 99999-0001', null, null, null])
    const buf = await wb.xlsx.writeBuffer()
    const rows = await parseXlsx(buf as ArrayBuffer)
    expect(rows).toEqual([
      { Nome: 'Cei', Telefone: 67999990000, Nascimento: '17/05/1990', Preço: 120.5, Total: 241 },
      { Nome: 'Construsul', Telefone: '(67) 99999-0001', Nascimento: '', Preço: '', Total: '' },
    ])
  })
})
