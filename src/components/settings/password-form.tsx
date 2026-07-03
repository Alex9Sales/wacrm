'use client';

import { KeyRound } from 'lucide-react';

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

// TODO(fase-2): password change used supabase.auth.signInWithPassword
// (to verify the current password) + supabase.auth.updateUser({ password }).
// Auth moves to Better Auth in Phase 2 — the form is disabled until then.
// The component keeps its name + export stable for the callers that import it.
export function PasswordForm() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <KeyRound className="size-4 text-primary" />
          Password
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Change the password you use to sign in.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Alert>
          <AlertTitle>Temporarily unavailable</AlertTitle>
          <AlertDescription>
            Alteração de senha volta na Fase 2.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
