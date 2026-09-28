'use client'

// ============================================================
// Checkout da assinatura — escolhe o plano + CPF/CNPJ e vai pro pagamento do
// Asaas (Pix/boleto/cartão na tela deles). Usado na tela de "trial acabou" e na
// faixa do teste grátis. SubscribeButton embute o próprio dialog.
// ============================================================

import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Check } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PLAN_LIST, formatPrice, type PlanKey } from '@/lib/billing/plans'
import { subscribeToPlan } from '@/components/billing/subscribe-actions'

interface SubscribeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultPlan?: PlanKey
}

export function SubscribeDialog({
  open,
  onOpenChange,
  defaultPlan = 'pro',
}: SubscribeDialogProps) {
  const [plan, setPlan] = useState<PlanKey>(defaultPlan)
  const [cpfCnpj, setCpfCnpj] = useState('')
  const [loading, setLoading] = useState(false)
  // Dados para a nota fiscal (28/09). Opcionais: esta é a tela onde o cliente
  // paga, e exigir CEP para deixar assinar troca uma nota mais fácil por uma
  // venda perdida. Ficam recolhidos para não dar cara de formulário longo.
  const [billingEmail, setBillingEmail] = useState('')
  const [cep, setCep] = useState('')
  const [rua, setRua] = useState('')
  const [numero, setNumero] = useState('')
  const [complemento, setComplemento] = useState('')
  const [bairro, setBairro] = useState('')
  const [cidade, setCidade] = useState('')
  const [uf, setUf] = useState('')

  const onSubmit = async () => {
    const digits = cpfCnpj.replace(/\D/g, '')
    if (digits.length !== 11 && digits.length !== 14) {
      toast.error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).')
      return
    }
    setLoading(true)
    try {
      const { url } = await subscribeToPlan(plan, cpfCnpj, {
        billingEmail,
        postalCode: cep,
        address: rua,
        addressNumber: numero,
        complement: complemento,
        province: bairro,
        city: cidade,
        state: uf,
      })
      // Redireciona pra tela de pagamento do Asaas (Pix/boleto/cartão).
      window.location.href = url
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Falha ao iniciar o pagamento.',
      )
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assinar o FluxiaCRM</DialogTitle>
          <DialogDescription>
            Escolha o plano e finalize o pagamento. Você escolhe Pix, boleto ou
            cartão na próxima tela. A assinatura é mensal e você pode cancelar
            quando quiser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="grid gap-2">
            {PLAN_LIST.map((p) => {
              const selected = p.key === plan
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPlan(p.key)}
                  className={`flex items-center justify-between rounded-lg border p-3 text-left transition ${
                    selected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:border-primary/40'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{p.name}</span>
                      {selected && <Check className="h-4 w-4 text-primary" />}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.tagline}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="font-semibold text-foreground">
                      {formatPrice(p.price)}
                    </span>
                    <span className="block text-xs text-muted-foreground">/mês</span>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cpfcnpj">CPF ou CNPJ do responsável</Label>
            <Input
              id="cpfcnpj"
              value={cpfCnpj}
              onChange={(e) => setCpfCnpj(e.target.value)}
              placeholder="Somente números"
              inputMode="numeric"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              Exigido pelo Asaas para emitir a cobrança. Seus dados de pagamento
              são tratados no ambiente seguro do Asaas.
            </p>
          </div>

          <details className="rounded-lg border border-border">
            <summary className="cursor-pointer px-3 py-2 text-sm text-foreground">
              Dados para nota fiscal
              <span className="ml-1.5 text-xs text-muted-foreground">(opcional)</span>
            </summary>
            <div className="space-y-2 border-t border-border p-3">
              <p className="text-[11px] text-muted-foreground">
                Se preencher agora, sua nota sai sem a gente precisar pedir
                depois. Não é obrigatório para assinar.
              </p>
              <Input
                type="email"
                value={billingEmail}
                onChange={(e) => setBillingEmail(e.target.value)}
                placeholder="E-mail do financeiro (para o boleto)"
                autoComplete="email"
              />
              <div className="grid grid-cols-3 gap-2">
                <Input
                  value={cep}
                  onChange={(e) => setCep(e.target.value)}
                  placeholder="CEP"
                  inputMode="numeric"
                  autoComplete="postal-code"
                />
                <Input
                  className="col-span-2"
                  value={cidade}
                  onChange={(e) => setCidade(e.target.value)}
                  placeholder="Cidade"
                  autoComplete="address-level2"
                />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <Input
                  className="col-span-3"
                  value={rua}
                  onChange={(e) => setRua(e.target.value)}
                  placeholder="Rua / avenida"
                  autoComplete="address-line1"
                />
                <Input
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  placeholder="Nº"
                />
              </div>
              <div className="grid grid-cols-4 gap-2">
                <Input
                  className="col-span-2"
                  value={bairro}
                  onChange={(e) => setBairro(e.target.value)}
                  placeholder="Bairro"
                />
                <Input
                  value={complemento}
                  onChange={(e) => setComplemento(e.target.value)}
                  placeholder="Compl."
                />
                <Input
                  value={uf}
                  onChange={(e) => setUf(e.target.value.toUpperCase())}
                  placeholder="UF"
                  maxLength={2}
                  autoComplete="address-level1"
                />
              </div>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button onClick={onSubmit} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            Ir para o pagamento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Botão que abre o checkout. `variant`/`className` passam pro Button. */
export function SubscribeButton({
  label = 'Assinar agora',
  defaultPlan,
  className,
  variant,
}: {
  label?: string
  defaultPlan?: PlanKey
  className?: string
  variant?: React.ComponentProps<typeof Button>['variant']
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button className={className} variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <SubscribeDialog open={open} onOpenChange={setOpen} defaultPlan={defaultPlan} />
    </>
  )
}
