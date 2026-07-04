'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { toast } from 'sonner';

import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

// Fase 8: alteração de senha reativada via Better Auth.
// `authClient.changePassword` verifica a senha atual, grava a nova e
// (com revokeOtherSessions) encerra as demais sessões do usuário — útil
// para o cliente provisionado que entra com a senha inicial e a troca.
const MIN_PASSWORD_LENGTH = 8; // combina com o mínimo do Better Auth.

export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(
        `A nova senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      );
      return;
    }

    if (newPassword !== confirmPassword) {
      toast.error('As senhas não coincidem.');
      return;
    }

    setSubmitting(true);

    const { error } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });

    if (error) {
      toast.error(
        error.message ??
          'Não foi possível alterar a senha. Verifique a senha atual.',
      );
      setSubmitting(false);
      return;
    }

    toast.success('Senha alterada');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setSubmitting(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <KeyRound className="size-4 text-primary" />
          Senha
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Altere a senha que você usa para entrar.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form onSubmit={handleSubmit} className="flex max-w-sm flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="currentPassword" className="text-muted-foreground">
              Senha atual
            </Label>
            <PasswordInput
              id="currentPassword"
              autoComplete="current-password"
              placeholder="Digite sua senha atual"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="newPassword" className="text-muted-foreground">
              Nova senha
            </Label>
            <PasswordInput
              id="newPassword"
              autoComplete="new-password"
              placeholder={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              disabled={submitting}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword" className="text-muted-foreground">
              Confirmar nova senha
            </Label>
            <PasswordInput
              id="confirmPassword"
              autoComplete="new-password"
              placeholder="Repita a nova senha"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              disabled={submitting}
            />
          </div>

          <Button type="submit" disabled={submitting} className="mt-2 w-fit">
            {submitting ? 'Alterando...' : 'Alterar senha'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
