# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

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
