"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Store, Upload, Trash2, Search } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { getCompanyData, saveCompanyData, lookupCnpj } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

/**
 * Dados da empresa — a identidade que aparece nas PROPOSTAS (e alimenta o
 * contexto da IA): logo, razão social, nome fantasia, CNPJ/CPF, site, descrição
 * e formas de pagamento. Logo vai pra organization.logo (separado do avatar do
 * usuário).
 */
export function CompanyForm() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [logo, setLogo] = useState<string | null>(null);
  const [tradeName, setTradeName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [docNum, setDocNum] = useState("");
  const [website, setWebsite] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");
  const [paymentMethods, setPaymentMethods] = useState("");
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    getCompanyData()
      .then((d) => {
        setLogo(d.logo);
        setTradeName(d.tradeName ?? "");
        setLegalName(d.legalName ?? "");
        setDocNum(d.document ?? "");
        setWebsite(d.website ?? "");
        setAddress(d.address ?? "");
        setPhone(d.phone ?? "");
        setDescription(d.description ?? "");
        setPaymentMethods(d.paymentMethods ?? "");
      })
      .catch(() => toast.error("Falha ao carregar os dados da empresa."))
      .finally(() => setLoading(false));
  }, []);

  async function onLogoPick(file: File | null) {
    if (!file) return;
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia("avatars", file);
      setLogo(publicUrl);
    } catch {
      toast.error("Falha ao enviar a logo.");
    } finally {
      setUploading(false);
    }
  }

  async function handleLookup() {
    const digits = docNum.replace(/\D/g, "");
    if (digits.length !== 14) {
      toast.error("Informe um CNPJ com 14 dígitos para buscar.");
      return;
    }
    setLooking(true);
    const res = await lookupCnpj(docNum);
    setLooking(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    if (res.legalName) setLegalName(res.legalName);
    if (res.tradeName) setTradeName(res.tradeName);
    if (res.address) setAddress(res.address);
    if (res.phone) setPhone(res.phone);
    toast.success("Dados do CNPJ preenchidos. Confira e salve.");
  }

  async function handleSave() {
    setSaving(true);
    const { error } = await saveCompanyData({
      logo,
      tradeName,
      legalName,
      document: docNum,
      website,
      address,
      phone,
      description,
      paymentMethods,
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Dados da empresa salvos.");
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Dados da empresa"
        description="A identidade que aparece nas suas propostas — e que a IA usa como contexto. Configure uma vez e vale pra tudo."
      />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Store className="size-4 text-primary" />
            Sua empresa
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            A logo e estes dados vão no cabeçalho das propostas. Você ainda pode
            personalizar por proposta na hora de gerar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <>
              {/* Logo */}
              <div className="flex items-center gap-4">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="logo" className="h-full w-full object-contain" />
                  ) : (
                    <Store className="size-6 text-muted-foreground" />
                  )}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-foreground hover:bg-background ${
                        !canEditSettings ? "pointer-events-none opacity-60" : ""
                      }`}
                    >
                      {uploading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Upload className="size-4" />
                      )}
                      Enviar logo
                      <input
                        type="file"
                        accept="image/*"
                        disabled={!canEditSettings}
                        onChange={(e) => void onLogoPick(e.target.files?.[0] ?? null)}
                        className="hidden"
                      />
                    </label>
                    {logo && canEditSettings ? (
                      <button
                        type="button"
                        onClick={() => setLogo(null)}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted-foreground hover:text-red-500"
                      >
                        <Trash2 className="size-4" /> Remover
                      </button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    PNG, JPG, WebP ou GIF — até 2 MB.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label>Nome fantasia</Label>
                  <Input
                    value={tradeName}
                    onChange={(e) => setTradeName(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="Como sua marca é conhecida"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Razão social</Label>
                  <Input
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="Nome registrado (opcional)"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>CNPJ / CPF</Label>
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={docNum}
                      onChange={(e) => setDocNum(e.target.value)}
                      disabled={!canEditSettings}
                      placeholder="00.000.000/0001-00"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleLookup()}
                      disabled={!canEditSettings || looking}
                      title="Buscar dados pelo CNPJ"
                    >
                      {looking ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Search className="size-4" />
                      )}
                      Buscar
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    CNPJ? Clique em Buscar pra preencher razão social, nome
                    fantasia e endereço automaticamente.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label>Site</Label>
                  <Input
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="www.suaempresa.com.br"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Endereço</Label>
                  <Input
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="Rua, número - bairro, cidade/UF"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>Telefone</Label>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="(00) 00000-0000"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>Descrição / slogan</Label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={!canEditSettings}
                    rows={2}
                    placeholder="Uma frase sobre o que sua empresa faz."
                    className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                  />
                </div>
                <div className="grid gap-1.5 sm:col-span-2">
                  <Label>Formas de pagamento</Label>
                  <Input
                    value={paymentMethods}
                    onChange={(e) => setPaymentMethods(e.target.value)}
                    disabled={!canEditSettings}
                    placeholder="Pix, cartão, boleto..."
                  />
                </div>
              </div>

              {!canEditSettings ? (
                <p className="text-xs text-muted-foreground">
                  Apenas administradores da conta podem alterar estes dados.
                </p>
              ) : (
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Salvando...
                    </>
                  ) : (
                    "Salvar"
                  )}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
