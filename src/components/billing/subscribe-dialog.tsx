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

  const onSubmit = async () => {
    const digits = cpfCnpj.replace(/\D/g, '')
    if (digits.length !== 11 && digits.length !== 14) {
      toast.error('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).')
      return
    }
    setLoading(true)
    try {
      const { url } = await subscribeToPlan(plan, cpfCnpj)
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
