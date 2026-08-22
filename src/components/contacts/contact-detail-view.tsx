'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  startNewConversation,
  listSendableChannels,
  type SendableChannel,
} from '@/app/(dashboard)/inbox/actions';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type { Contact, Tag, ContactNote, CustomField, Deal, MessageTemplate } from '@/types';
import {
  listTags,
  getContact,
  listContactTagIds,
  toggleContactTag,
  updateContactDetails,
  listContactNotes,
  addContactNote,
  deleteContactNote,
  listCustomFields,
  listContactCustomValues,
  saveContactCustomValues,
  listContactDeals,
  setContactOptedOut,
} from '@/app/(dashboard)/contacts/actions';
import {
  listScheduledForContact,
  type ScheduledMessageLite,
} from '@/app/(dashboard)/inbox/schedule-actions';
import { ScheduleMiniList } from '@/components/inbox/schedule-mini-list';
import { CallButton } from '@/components/calls/call-button';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  BellOff,
  Loader2,
  Plus,
  Trash2,
  Save,
  X,
  DollarSign,
  LayoutTemplate,
  MessageSquare,
} from 'lucide-react';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const { defaultCurrency } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);

  // Canais oficiais que podem originar a conversa. Com 2+, aparece um seletor
  // pro atendente escolher de qual número abre a conversa / manda o modelo.
  const [channels, setChannels] = useState<SendableChannel[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string>('');
  useEffect(() => {
    if (!open) return;
    listSendableChannels()
      .then((cs) => {
        setChannels(cs);
        setSelectedChannelId((prev) => prev || cs[0]?.id || '');
      })
      .catch(() => setChannels([]));
  }, [open]);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  // Mensagens agendadas do contato (aba Agendadas).
  const [scheduled, setScheduled] = useState<ScheduledMessageLite[]>([]);

  const fetchScheduled = useCallback(async () => {
    if (!contactId) return;
    try {
      setScheduled(await listScheduledForContact(contactId));
    } catch {
      setScheduled([]);
    }
  }, [contactId]);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    try {
      const data = await getContact(contactId);
      if (data) {
        setContact(data);
        setEditName(data.name ?? '');
        setEditPhone(data.phone);
        setEditEmail(data.email ?? '');
        setEditCompany(data.company ?? '');
      }
    } catch {
      // Leave contact null → the sheet shows its loading/empty state.
    }
    setLoading(false);
  }, [contactId]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    try {
      const [tagsData, tagIds] = await Promise.all([
        listTags(),
        listContactTagIds(contactId),
      ]);
      setAllTags([...tagsData].sort((a, b) => a.name.localeCompare(b.name)));
      setContactTagIds(tagIds);
    } catch {
      // Non-fatal; tabs render their empty states.
    }
  }, [contactId]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    try {
      const data = await listContactNotes(contactId);
      setNotes(data);
    } catch {
      setNotes([]);
    }
    setLoadingNotes(false);
  }, [contactId]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    try {
      const [fields, values] = await Promise.all([
        listCustomFields(),
        listContactCustomValues(contactId),
      ]);
      // Só campos do CONTATO aqui (os de NEGÓCIO vivem no detalhe do negócio).
      setCustomFields(fields.filter((f) => (f.entity ?? "contact") === "contact"));
      const map: Record<string, string> = {};
      values.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    } catch {
      // Non-fatal.
    }
    setLoadingCustom(false);
  }, [contactId]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    try {
      const data = await listContactDeals(contactId);
      setDeals(data);
    } catch {
      setDeals([]);
    }
    setLoadingDeals(false);
  }, [contactId]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
      fetchScheduled();
    }
  }, [open, contactId, fetchContact, fetchTags, fetchNotes, fetchCustomFields, fetchDeals, fetchScheduled]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function toggleOptOut() {
    if (!contact) return;
    const next = !contact.opted_out;
    // Otimista — reflete na hora; reverte no erro.
    setContact({ ...contact, opted_out: next });
    try {
      await setContactOptedOut(contact.id, next);
      toast.success(
        next
          ? 'Contato bloqueado — disparos e agendamentos vão pular.'
          : 'Envios reativados para este contato.',
      );
      onUpdated();
    } catch {
      setContact({ ...contact, opted_out: !next });
      toast.error('Não foi possível atualizar.');
    }
  }

  // Abrir a conversa direto (não-oficial): resolve/cria a conversa desse
  // contato e navega pra ela. Felipe: cliente já cadastrado que só quer
  // continuar a conversa, sem precisar de template oficial.
  async function openConversation() {
    if (!contact || openingChat) return;
    setOpeningChat(true);
    try {
      const { conversationId } = await startNewConversation({
        phone: contact.phone,
        name: contact.name ?? null,
        channelId: selectedChannelId || null,
      });
      // Navegação COMPLETA (não router.push): remonta a inbox e reativa o
      // deep-link `?c=`, e é robusta contra bundle velho (aba desatualizada
      // depois de deploy) — o client-side push podia falhar ao carregar chunk.
      window.location.href = `/inbox?c=${conversationId}`;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Não foi possível abrir a conversa.',
      );
    } finally {
      setOpeningChat(false);
    }
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error('O número de telefone é obrigatório');
      return;
    }

    setSavingDetails(true);
    const { error } = await updateContactDetails({
      contactId,
      name: editName,
      phone: editPhone,
      email: editEmail,
      company: editCompany,
    });

    if (error) {
      toast.error(error || 'Falha ao atualizar contato');
    } else {
      toast.success('Contato atualizado');
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);
    const { error } = await toggleContactTag(contactId, tagId, !isSelected);
    if (!error) {
      setContactTagIds((prev) =>
        isSelected ? prev.filter((id) => id !== tagId) : [...prev, tagId],
      );
      onUpdated();
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const { error } = await addContactNote(contactId, newNote.trim());
    if (error) {
      toast.error(error || 'Falha ao adicionar nota');
    } else {
      setNewNote('');
      fetchNotes();
      toast.success('Nota adicionada');
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await deleteContactNote(noteId);
    if (error) {
      toast.error(error || 'Falha ao excluir nota');
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success('Nota excluída');
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    const { error } = await saveContactCustomValues(contactId, customValues);
    if (error) {
      toast.error(error || 'Falha ao salvar campos personalizados');
    } else {
      toast.success('Campos personalizados salvos');
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      const res = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // No conversation_id — the route find-or-creates one for this
          // contact (no canal escolhido), mirroring the inbox template-send.
          contact_id: contactId,
          channel_id: selectedChannelId || undefined,
          message_type: 'template',
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = payload?.error || `HTTP ${res.status}`;
        toast.error(`Falha ao enviar modelo: ${reason}`);
        return;
      }

      toast.success(`Modelo "${template.name}" enviado`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'erro de rede';
      toast.error(`Falha ao enviar modelo: ${reason}`);
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header */}
            <SheetHeader className="p-4 border-b border-border/50">
              <div className="flex items-center gap-3">
                <Avatar className="size-12 bg-muted border border-border">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-popover-foreground truncate">
                    {contact.name || 'Desconhecido'}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground text-xs mt-0.5">
                    Detalhes do contato
                  </SheetDescription>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                    <button
                      onClick={copyPhone}
                      className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                    >
                      <Phone className="size-3" />
                      {contact.phone}
                      {copiedPhone ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    {contact.phone && !contact.is_group && (
                      <CallButton
                        phone={contact.phone}
                        name={contact.name}
                        variant="pill"
                        title="Ligar para o contato (voz WhatsApp)"
                      />
                    )}
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                  {/* Anti-ban: selo "Não perturbe" + botão de bloquear/reativar. */}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {contact.opted_out && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300"
                      >
                        <BellOff className="mr-1 size-3" />
                        Não perturbe
                      </Badge>
                    )}
                    <button
                      type="button"
                      onClick={toggleOptOut}
                      className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {contact.opted_out
                        ? 'Reativar envios'
                        : 'Bloquear envios (não perturbe)'}
                    </button>
                  </div>
                </div>
              </div>
              {/* Seletor de canal — só quando a conta tem 2+ números oficiais.
                  Os dois botões (abrir conversa / enviar modelo) usam o canal
                  escolhido aqui. Com 1 canal, some (usa o default). */}
              {channels.length > 1 && (
                <div className="mt-3">
                  <label className="mb-1 block text-xs text-muted-foreground">
                    Canal
                  </label>
                  <select
                    value={selectedChannelId}
                    onChange={(e) => setSelectedChannelId(e.target.value)}
                    className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  >
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.phoneNumber ? ` · ${c.phoneNumber}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={openConversation}
                  disabled={openingChat}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {openingChat ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageSquare className="size-4" />
                  )}
                  Abrir conversa
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setTemplatePickerOpen(true)}
                  disabled={sendingTemplate}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  {sendingTemplate ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LayoutTemplate className="size-4" />
                  )}
                  Enviar modelo
                </Button>
              </div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Detalhes
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Etiquetas
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Notas
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Campos personalizados
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Negócios
                </TabsTrigger>
                <TabsTrigger
                  value="scheduled"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Agendadas
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Nome</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Phone <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Email</Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Company</Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                    size="sm"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    Save Changes
                  </Button>
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent value="tags" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Click a tag to add or remove it from this contact.
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No tags available. Create tags in Settings.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const selected = contactTagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            disabled={savingTags}
                            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
                              selected
                                ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="size-3 mr-1" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                <div className="space-y-2 mb-3">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Escreva uma nota..."
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] text-sm resize-none"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    Add Note
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No notes yet.
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-lg bg-muted/50 border border-border/50 p-3 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap flex-1">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all cursor-pointer shrink-0"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5">
                          {new Date(note.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No custom fields defined. Create them in Settings.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={`Enter ${field.field_name}...`}
                          className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                        />
                      </div>
                    ))}
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      Save Custom Fields
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-primary" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nenhum negócio ainda</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="rounded-lg border border-border bg-muted/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency,
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Agendadas Tab — mensagens agendadas deste contato (reflete as
                  criadas na conversa E na Central de Agendamentos). */}
              <TabsContent value="scheduled" className="flex-1 overflow-y-auto px-4 py-3">
                <ScheduleMiniList
                  items={scheduled}
                  onChanged={fetchScheduled}
                  emptyLabel="Nenhuma mensagem agendada para este contato."
                />
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
    <TemplatePicker
      open={templatePickerOpen}
      onOpenChange={setTemplatePickerOpen}
      onSelect={handleSendTemplate}
      contactName={contact?.name}
    />
    </>
  );
}
