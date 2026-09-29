# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [0.1.1] - 2026-09-29

### Corrigido

- `completeVnuvIdLogin` agora emite o evento `"linked"`/`"signup"` no momento em que a conta é
  resolvida, não só quando o login termina com sucesso. Na v0.1.0 esse evento só disparava após
  passar pelo gate de MFA — o que faria um app perder o alerta de "conta vinculada" (e o audit
  correspondente) sempre que a conta recém-vinculada/criada também tivesse MFA habilitado, já
  que o gate de MFA intercepta antes do fim do fluxo. Agora reproduz exatamente a ordem do
  Nicho em produção: vínculo/criação é registrado assim que acontece, independente do que o
  MFA decidir a seguir.

## [0.1.0] - 2026-09-29

### Adicionado

- Camada de protocolo (`protocol.ts`): PKCE/state, `buildAuthorizeUrl`, `exchangeCodeForTokens`,
  `verifyVnuvIdToken`, `fetchVnuvIdUserinfo` — portada de `nicho/src/lib/security/vnuv-id-oauth.ts`,
  trocando as chamadas de `crypto` do Node por Web Crypto para funcionar também em runtimes edge
  (Cloudflare Workers).
- Camada de orquestração (`orchestrator.ts`): `VnuvIdAdapter`, `completeVnuvIdLogin`,
  `handleVnuvIdCallback` — política de auto-vínculo por e-mail e gate de MFA idêntica à do Nicho
  em produção.
- Suíte de testes (protocolo + orquestrador com adapter fake em memória).
