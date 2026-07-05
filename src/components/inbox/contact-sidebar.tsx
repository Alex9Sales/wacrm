"use client";

import { useState, useEffect, useCallback } from "react";
import {
  addContactNote,
  listContactDeals,
  listContactNotes,
  listContactTagsWithJoinId,
} from "@/app/(dashboard)/inbox/actions";
import { getContact, getContactTags } from "@/app/(dashboard)/contacts/actions";
import type { Contact, Deal, ContactNote, Tag, ContactTag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactAvatar } from "./contact-avatar";
import { toast } from "sonner";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
  /**
   * Fired after the operator edits the contact inline (name/email/company/
   * tags) so the page can update the active contact — which drives the
   * thread header and the conversation-list row — without a reload.
   */
  onContactUpdated?: (contact: Contact) => void;
}

export function ContactSidebar({ contact, onContactUpdated }: ContactSidebarProps) {
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  // Inline contact edit — reuses the full Contacts page ContactForm in a
  // dialog so the operator can name/edit the contact right here.
  const [editOpen, setEditOpen] = useState(false);
  const [editTags, setEditTags] = useState<ContactTag[]>([]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;
    const contactId = contact.id;

    // Fetch deals, notes, and tags in parallel via account-scoped actions.
    try {
      const [dealsData, notesData, tagsData, editTagsData] = await Promise.all([
        listContactDeals(contactId),
        listContactNotes(contactId),
        listContactTagsWithJoinId(contactId),
        getContactTags(contactId),
      ]);
      setDeals(dealsData);
      setNotes(notesData);
      setTags(tagsData);
      setEditTags(editTagsData);
    } catch (error) {
      console.error("Failed to fetch contact data:", error);
    }
  }, [contact]);

  // After a successful edit, re-read the contact + its tag chips and push
  // the fresh contact up so the thread header + conversation-list row
  // reflect the new name immediately.
  const handleContactSaved = useCallback(async () => {
    if (!contact) return;
    try {
      const [updated, editTagsData, tagsData] = await Promise.all([
        getContact(contact.id),
        getContactTags(contact.id),
        listContactTagsWithJoinId(contact.id),
      ]);
      setEditTags(editTagsData);
      setTags(tagsData);
      if (updated) {
        onContactUpdated?.(updated);
        toast.success("Contato atualizado");
      }
    } catch (error) {
      console.error("Failed to refresh contact after edit:", error);
    }
  }, [contact, onContactUpdated]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    setAddingNote(true);

    // The action derives author (user_id) + account from the session —
    // the client no longer looks up or passes them.
    try {
      const data = await addContactNote(contact.id, newNote.trim());
      if (data) {
        setNotes((prev) => [data, ...prev]);
        setNewNote("");
      }
    } catch (error) {
      console.error("Failed to add note:", error);
    } finally {
      setAddingNote(false);
    }
  }, [contact, newNote]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            {/* AVATAR image (owned by the avatar agent). Name/fields edit
                below is owned separately. */}
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-muted text-lg font-semibold text-foreground">
              <ContactAvatar
                avatarUrl={contact.avatar_url}
                displayName={displayName}
                className="h-16 w-16"
              />
            </div>
            <div className="mt-3 flex items-center gap-1">
              <h3 className="text-sm font-semibold text-foreground">
                {displayName}
              </h3>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                aria-label="Editar contato"
                title="Editar contato"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
            {!contact.name && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Adicionar nome
              </button>
            )}
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              Tags
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No tags</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              Active Deals
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No deals</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              Notes
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* Inline contact editor — the full Contacts-page form (name, phone,
          email, company, tags) reused in a dialog so the operator can
          name/register the contact without leaving the inbox. */}
      <ContactForm
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={contact}
        contactTags={editTags}
        onSaved={handleContactSaved}
      />
    </div>
  );
}
