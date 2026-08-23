// ============================================================
// Fundos generativos do hero da landing (estilo Haikei/Trianglify), gerados
// POR CÓDIGO na cor da marca — zero dependência e zero risco de licença
// (Trianglify é GPLv3; aqui é implementação própria). Determinístico: o seed
// (slug do form) gera sempre o mesmo desenho, estável entre renders/SSR.
// Puro (sem DB, sem server-only) → usável no server component da landing.
// ============================================================

/** Hash de string → seed 32-bit (FNV-1a). */
function hashSeed(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** PRNG determinístico (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0x7c3aed
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

// ------------------------------------------------------------
// Low-poly (visual Trianglify, implementação própria): grade de pontos com
// jitter → 2 triângulos por célula, cada um com opacidade própria da cor da
// marca. Mais denso embaixo (o hero "assenta" no conteúdo).
// ------------------------------------------------------------
export interface LowPolyTriangle {
  points: string
  opacity: number
}

export function lowPolyTriangles(
  seedStr: string,
  width = 1440,
  height = 560,
  cols = 12,
  rows = 6,
): LowPolyTriangle[] {
  const rand = mulberry32(hashSeed(`lowpoly:${seedStr}`))
  const cw = width / cols
  const ch = height / rows
  // Malha de pontos jitterados (bordas presas pra cobrir a área toda).
  const pts: { x: number; y: number }[][] = []
  for (let r = 0; r <= rows; r++) {
    const row: { x: number; y: number }[] = []
    for (let c = 0; c <= cols; c++) {
      const jx = c === 0 || c === cols ? 0 : (rand() - 0.5) * cw * 0.9
      const jy = r === 0 || r === rows ? 0 : (rand() - 0.5) * ch * 0.9
      row.push({ x: c * cw + jx, y: r * ch + jy })
    }
    pts.push(row)
  }
  const out: LowPolyTriangle[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = pts[r][c]
      const b = pts[r][c + 1]
      const d = pts[r + 1][c]
      const e = pts[r + 1][c + 1]
      // Diagonal alternada (semeada) pra malha orgânica.
      const flip = rand() > 0.5
      const tris = flip
        ? [
            [a, b, e],
            [a, e, d],
          ]
        : [
            [a, b, d],
            [b, e, d],
          ]
      for (const t of tris) {
        // Mais opaco quanto mais baixo (r/rows) + variação aleatória.
        const depth = (r + 1) / rows
        const opacity = 0.03 + depth * 0.1 + rand() * 0.07
        out.push({
          points: t.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' '),
          opacity: Math.round(opacity * 100) / 100,
        })
      }
    }
  }
  return out
}

// ------------------------------------------------------------
// Grade (Haikei "grid"): pontos acesos em interseções semeadas — as linhas
// são um <pattern> SVG no componente; aqui só os destaques.
// ------------------------------------------------------------
export interface GridDot {
  x: number
  y: number
  r: number
  opacity: number
}

export function gridDots(
  seedStr: string,
  width = 1440,
  height = 560,
  step = 48,
): GridDot[] {
  const rand = mulberry32(hashSeed(`grid:${seedStr}`))
  const out: GridDot[] = []
  for (let y = step; y < height; y += step) {
    for (let x = step; x < width; x += step) {
      const roll = rand()
      if (roll > 0.94) {
        out.push({
          x,
          y,
          r: roll > 0.985 ? 5 : 3,
          opacity: 0.25 + rand() * 0.35,
        })
      }
    }
  }
  return out
}

// ------------------------------------------------------------
// Mesh gradient (estilo Stripe): radial-gradients em camadas nas variações de
// matiz da cor da marca, posições semeadas. Vira `background` CSS da seção.
// ------------------------------------------------------------
export function meshGradientBackground(accent: string, seedStr: string): string {
  const rand = mulberry32(hashSeed(`mesh:${seedStr}`))
  const { r, g, b } = hexToRgb(accent)
  const [h, s] = rgbToHsl(r, g, b)
  const sat = Math.round(Math.min(1, Math.max(0.45, s)) * 100)
  const stop = (hueShift: number, alpha: number, light: number) =>
    `hsla(${Math.round((h + hueShift + 360) % 360)}, ${sat}%, ${light}%, ${alpha})`
  const pos = () => `${Math.round(8 + rand() * 84)}% ${Math.round(rand() * 70)}%`
  const layers = [
    `radial-gradient(at ${pos()}, ${stop(0, 0.16, 62)} 0px, transparent 55%)`,
    `radial-gradient(at ${pos()}, ${stop(28, 0.13, 68)} 0px, transparent 50%)`,
    `radial-gradient(at ${pos()}, ${stop(-24, 0.12, 66)} 0px, transparent 55%)`,
    `radial-gradient(at ${pos()}, ${stop(14, 0.1, 72)} 0px, transparent 45%)`,
    `radial-gradient(at 50% 120%, ${stop(0, 0.14, 60)} 0px, transparent 60%)`,
  ]
  return `${layers.join(', ')}, linear-gradient(180deg, #ffffff 0%, #ffffff 100%)`
}
