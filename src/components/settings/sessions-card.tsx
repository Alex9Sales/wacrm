'use client';

import { LogOut } from 'lucide-react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';

// TODO(fase-2): "sign out of all devices" used
// supabase.auth.signOut({ scope: 'global' }) to revoke every refresh
// token across devices. Session management moves to Better Auth in
// Phase 2 — the control is disabled until then. Export stays stable for
// the callers that import it.
export function SessionsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <LogOut className="size-4 text-primary" />
          Active sessions
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Sign out of every device where you&apos;re logged in — useful if you
          lost a laptop or shared your password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert>
          <AlertTitle>Temporarily unavailable</AlertTitle>
          <AlertDescription>
            Gerenciamento de sessões volta na Fase 2.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
