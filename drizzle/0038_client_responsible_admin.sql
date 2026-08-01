-- "Responsável" do cliente no painel /admin (sociedade Alex + Rafael): qual admin
-- DA PLATAFORMA cadastrou / é dono da conta. Preenchido automaticamente no
-- provisionamento; editável depois (transferir cliente de um admin pro outro) e
-- usado pela coluna "Responsável" + filtro "Meus/Todos". Nullable, SEM FK — o
-- usuário admin não deve cascatear/bloquear; se sumir, a linha só mostra "—".
ALTER TABLE "organization_billing" ADD COLUMN IF NOT EXISTS "responsible_admin_id" uuid;
