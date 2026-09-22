-- 🔔 Carimbo da última leitura dos próximos vencimentos (tela "Próximos
-- vencimentos", 22/09). A tela mostrava "ainda não li o Asaas" para sempre
-- numa conta sem parcela a vencer: o "lido às" vinha das linhas gravadas, e
-- zero linhas não têm carimbo. Rodar nos DOIS bancos antes do deploy.
ALTER TABLE "asaas_connections" ADD COLUMN IF NOT EXISTS "upcoming_scanned_at" timestamptz;
