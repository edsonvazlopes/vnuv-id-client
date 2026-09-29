# vnuv-id-client

Camada de protocolo e orquestração compartilhada para apps do ecossistema VNUV delegarem
login ao [VNUV ID](https://id.vnuv.net) (Identity Provider OIDC central do ecossistema).

Este pacote existe pra que integrar um novo app ao VNUV ID seja instalar uma dependência e
implementar uma interface pequena — não ler um guia e reimplementar tudo do zero. O `nicho`
é a implementação de referência que consome este pacote.

## O que este pacote resolve (e o que não resolve)

Resolve, de forma idêntica em qualquer runtime (Node/Vercel ou Cloudflare Workers):

- Gerar `state` + par PKCE, montar a URL de autorização.
- Trocar o `code` por tokens, verificar o `id_token` (assinatura/issuer/audience via JWKS
  remoto), buscar o perfil real no `/me` (userinfo) e conferir que o `sub` bate nos dois passos.
- A política de auto-vínculo de conta: achar por `sub` → se não achar, achar por e-mail e
  vincular (sem duplicar) ou criar conta nova → checar bloqueio de conta → checar MFA (nunca
  pulado, seja qual for o método usado no VNUV ID) → só então criar sessão.

**Não resolve** (fica sempre no app cliente, por design):
- Cookies de `state`/PKCE e a rota `/api/auth/vnuv-id/start`/`callback` em si.
- O middleware/redirect automático quando a pessoa está deslogada (decisão de UX de cada app).
- Como o app guarda usuário/sessão no seu próprio banco — isso é o `VnuvIdAdapter`.
- Rate limiting, envio de e-mail, auditoria — use o hook opcional `onAuthEvent`.
- Fluxos específicos de um app só (ex.: reautenticação sem senha do Nicho via `purpose=reauth`).

## Instalação

```json
{
  "dependencies": {
    "vnuv-id-client": "github:edsonvazlopes/vnuv-id-client#v0.1.0"
  }
}
```

Em Next.js, adicione ao `next.config.ts`:

```ts
const nextConfig = {
  transpilePackages: ["vnuv-id-client"],
};
```

Sempre fixe uma **tag exata** (`#v0.1.0`), nunca `#main` — assim atualizar de versão é um diff
de uma linha, revertível sem migração de dados.

## Uso

### 1. Registrar o client

Ainda não há painel admin — registre rodando `scripts/register-oidc-client.ts` no repo
`vnuv-id`. Guarde `VNUV_ID_ISSUER`, `VNUV_ID_CLIENT_ID`, `VNUV_ID_CLIENT_SECRET`.

### 2. Rota `/api/auth/vnuv-id/start`

```ts
import { createPkcePair, createState, buildAuthorizeUrl } from "vnuv-id-client";

const state = createState();
const { verifier, challenge } = await createPkcePair(); // async — usa Web Crypto
// grave state/verifier em cookies httpOnly de uso único, TTL curto (~10min)

const url = buildAuthorizeUrl(
  { issuer: process.env.VNUV_ID_ISSUER!, clientId: process.env.VNUV_ID_CLIENT_ID! },
  { state, codeChallenge: challenge, redirectUri: "https://seuapp.vnuv.net/api/auth/vnuv-id/callback" }
);
// redirecione pra `url`
```

### 3. Implementar o `VnuvIdAdapter`

```ts
import type { VnuvIdAdapter } from "vnuv-id-client";

const adapter: VnuvIdAdapter<MeuUser> = {
  findExternalIdentity: (providerSub) => db.externalIdentity.findByProviderSub(providerSub),
  findUserById: (id) => db.user.findById(id),
  findUserByEmail: (email) => db.user.findByEmail(email),
  createExternalIdentity: (user, providerSub, email) =>
    db.externalIdentity.create({ userId: user.id, providerSub, email }),
  createUserWithExternalIdentity: (email, providerSub) =>
    db.user.createWithExternalIdentity(email, providerSub), // sem senha local
  markUserEmailVerified: (user) => db.user.markEmailVerified(user.id),
  isAccountLocked: (user) => Boolean(user.lockedUntil && user.lockedUntil > new Date()),
  getMfaRequirement: (user) => (user.mfaEnabled ? { challengeToken: gerarChallenge(user) } : null),
  createSession: (user, opts) => criarSessaoLocal(user, opts.remember),
  onAuthEvent: (event) => auditLog.write(event), // opcional
};
```

### 4. Rota `/api/auth/vnuv-id/callback`

Caso comum (sem fluxo adicional específico do seu app):

```ts
import { handleVnuvIdCallback } from "vnuv-id-client";

const result = await handleVnuvIdCallback(
  { issuer, clientId, clientSecret },
  { code, codeVerifier, redirectUri },
  adapter
);

if (!result.ok) {
  // result.code: "EMAIL_UNVERIFIED" | "ACCOUNT_LOCKED" | "MFA_REQUIRED"
}
```

Se seu app precisa do `sub` verificado *antes* de decidir o que fazer (ex.: um fluxo de
reautenticação de usuário já logado, como o Nicho tem), chame as peças separadas —
`exchangeCodeForTokens` → `verifyVnuvIdToken` → `fetchVnuvIdUserinfo` → confira
`profile.sub === sub` você mesmo → `completeVnuvIdLogin` — em vez do atalho.

### 5. Redirect automático quando deslogado

Fica no middleware/edge do seu app, não em `useEffect` (evita flash da tela antiga). Sempre
mantenha um fallback de login local (`?local=1` ou equivalente) — importante para quando o
VNUV ID estiver fora do ar, para estados de erro/MFA pendente, e para não reautenticar
silenciosamente logo após um logout explícito.

## Pitfalls já sofridos

- `id_token` não traz e-mail/nome — vem só do `/me` (por isso `handleVnuvIdCallback` já faz
  isso por você).
- Cookie de `Cross-Origin-Resource-Policy: same-origin` em toda resposta bloqueia o favicon do
  seu app na vitrine do VNUV ID (`/account`) — abra exceção `cross-origin` só pra assets
  estáticos públicos.
- Logout do seu app não desloga do VNUV ID (comportamento correto de SSO) — sempre use o
  fallback local depois de um logout explícito, senão a sessão do VNUV ID reautentica na hora
  e "Sair" parece quebrado.

Lista completa e ADRs relacionados: `vnuv-id/docs/integracao-clientes-oidc.md`.

## Desenvolvimento

```
npm install
npm run typecheck
npm test
```
