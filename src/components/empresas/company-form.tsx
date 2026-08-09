'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import {
  createCompany,
  updateCompany,
  type CompanyInput,
} from '@/app/(dashboard)/empresas/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Loader2 } from 'lucide-react'

export interface CompanyFormValue extends CompanyInput {
  id: string
}

/** Dialog de criar/editar empresa. Com `company` vira modo edição. */
export function CompanyForm({
  open,
  onOpenChange,
  company,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  company?: CompanyFormValue | null
  onSaved: (companyId?: string) => void
}) {
  const isEdit = !!company
  const [name, setName] = useState('')
  const [segment, setSegment] = useState('')
  const [website, setWebsite] = useState('')
  const [phone, setPhone] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(company?.name ?? '')
    setSegment(company?.segment ?? '')
    setWebsite(company?.website ?? '')
    setPhone(company?.phone ?? '')
    setNotes(company?.notes ?? '')
  }, [open, company])

  async function submit() {
    if (!name.trim()) {
      toast.error('O nome da empresa é obrigatório.')
      return
    }
    setSaving(true)
    const payload: CompanyInput = {
      name: name.trim(),
      segment: segment.trim() || null,
      website: website.trim() || null,
      phone: phone.trim() || null,
      notes: notes.trim() || null,
    }
    if (isEdit) {
      const res = await updateCompany(company!.id, payload)
      setSaving(false)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success('Empresa atualizada')
      onSaved(company!.id)
    } else {
      const res = await createCompany(payload)
      setSaving(false)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success('Empresa criada')
      onSaved(res.company.id)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar empresa' : 'Nova empresa'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Atualize os dados da empresa.'
              : 'Cadastre uma empresa para agrupar contatos e negócios.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="company-name">Nome *</Label>
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: RA Consultoria"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="company-segment">Segmento</Label>
              <Input
                id="company-segment"
                value={segment}
                onChange={(e) => setSegment(e.target.value)}
                placeholder="Ex.: Odontologia"
              />
            </div>
            <div>
              <Label htmlFor="company-phone">Telefone</Label>
              <Input
                id="company-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Ex.: (11) 99999-0000"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="company-website">Site</Label>
            <Input
              id="company-website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="Ex.: raconsultoria.com.br"
            />
          </div>
          <div>
            <Label htmlFor="company-notes">Observações</Label>
            <Textarea
              id="company-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Anotações sobre a empresa…"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {isEdit ? 'Salvar' : 'Criar empresa'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
