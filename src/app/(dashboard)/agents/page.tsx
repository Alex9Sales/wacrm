'use client';

// ============================================================
// Agentes IA — painel de controle (Fase A). O landing é o PAINEL (cards dos
// agentes). Clicar num card abre a config daquele agente (Configuração +
// Playground). "Base de Conhecimento" (o Núcleo compartilhado) e "Voz" ficam
// acessíveis pelo cabeçalho do painel.
// ============================================================

import { useState } from 'react';
import {
  Bot,
  Sparkles,
  Settings2,
  Phone,
  BookOpen,
  ArrowLeft,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { KnowledgeTab } from '@/components/agents/knowledge-tab';
import { VoiceAgentsTab } from '@/components/agents/voice-agents-tab';
import { AgentsPanel } from '@/components/agents/agents-panel';

type View =
  | { kind: 'panel' }
  | { kind: 'agent'; id: string }
  | { kind: 'new-first' }
  | { kind: 'knowledge' }
  | { kind: 'voice' };

export default function AgentsPage() {
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const [view, setView] = useState<View>({ kind: 'panel' });

  const back = () => setView({ kind: 'panel' });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {view.kind !== 'panel' && (
            <Button variant="ghost" size="sm" onClick={back} className="-ml-2">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Painel
            </Button>
          )}
          <Bot className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Agentes IA
          </h1>
        </div>

        {view.kind === 'panel' && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setView({ kind: 'knowledge' })}
            >
              <BookOpen className="mr-1.5 h-4 w-4" /> Base de Conhecimento
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setView({ kind: 'voice' })}
            >
              <Phone className="mr-1.5 h-4 w-4" /> Voz
            </Button>
          </div>
        )}
      </div>

      {view.kind === 'panel' && (
        <p className="mt-1 text-sm text-muted-foreground">
          Cada agente responde nos canais que você escolher, com a sua chave.
          Clique num card para configurar. A Base de Conhecimento é
          compartilhada por todos.
        </p>
      )}

      <div className="mt-6">
        {view.kind === 'panel' && (
          <AgentsPanel
            canEdit={canEdit}
            onOpen={(id) => setView({ kind: 'agent', id })}
            onFirstSetup={() => setView({ kind: 'new-first' })}
          />
        )}

        {view.kind === 'new-first' && (
          <AiConfig onChanged={back} />
        )}

        {view.kind === 'agent' && (
          <Tabs defaultValue="setup">
            <TabsList>
              <TabsTrigger value="setup">
                <Settings2 className="mr-1.5 h-4 w-4" /> Configuração
              </TabsTrigger>
              <TabsTrigger value="playground">
                <Sparkles className="mr-1.5 h-4 w-4" /> Playground
              </TabsTrigger>
            </TabsList>
            <TabsContent value="setup" className="mt-4">
              <AiConfig key={view.id} agentId={view.id} />
            </TabsContent>
            <TabsContent value="playground" className="mt-4">
              <AiPlayground agentId={view.id} />
            </TabsContent>
          </Tabs>
        )}

        {view.kind === 'knowledge' && <KnowledgeTab />}

        {view.kind === 'voice' && <VoiceAgentsTab />}
      </div>
    </div>
  );
}
