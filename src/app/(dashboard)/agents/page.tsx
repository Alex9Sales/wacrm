'use client';

import { useEffect, useState } from 'react';
import { Bot, Sparkles, Settings2, Phone, BookOpen } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { KnowledgeTab } from '@/components/agents/knowledge-tab';
import { VoiceAgentsTab } from '@/components/agents/voice-agents-tab';

type Tab = 'playground' | 'knowledge' | 'setup' | 'voice';

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  // Land first-time users on Setup, returning users on the Playground.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'playground' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Agentes IA
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Seu agente de IA com chave própria — configure-o e depois teste-o no
        playground antes que ele responda aos clientes na caixa de entrada.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Playground
            </TabsTrigger>
            <TabsTrigger value="knowledge">
              <BookOpen className="mr-1.5 h-4 w-4" /> Base de Conhecimento
            </TabsTrigger>
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Configuração
            </TabsTrigger>
            <TabsTrigger value="voice">
              <Phone className="mr-1.5 h-4 w-4" /> Voz
            </TabsTrigger>
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="knowledge" className="mt-4">
            <KnowledgeTab />
          </TabsContent>

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>

          <TabsContent value="voice" className="mt-4">
            <VoiceAgentsTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
