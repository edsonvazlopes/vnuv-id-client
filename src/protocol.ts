import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBase64Url, sha256Base64Url } from "./crypto-web.js";

export interface VnuvIdConfig {
  /** Base URL do issuer OIDC, sem barra final. Ex.: https://id.vnuv.net/api/oidc */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export type VnuvIdProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
};

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, "");
}

// createRemoteJWKSet guarda as chaves em memória e só refaz o fetch do JWKS
// quando encontra um kid desconhecido — cache por issuer, a nível de módulo.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string) {
  const normalized = normalizeIssuer(issuer);
  let jwks = jwksCache.get(normalized);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${normalized}/jwks`));
    jwksCache.set(normalized, jwks);
  }
  return jwks;
}

export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url();
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function createState(): string {
  return randomBase64Url();
}

export function buildAuthorizeUrl(
  config: Pick<VnuvIdConfig, "issuer" | "clientId">,
  params: { state: string; codeChallenge: string; redirectUri: string; scope?: string }
): string {
  const search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: params.scope ?? "openid email profile",
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${normalizeIssuer(config.issuer)}/auth?${search.toString()}`;
}

export async function exchangeCodeForTokens(
  config: VnuvIdConfig,
  params: { code: string; codeVerifier: string; redirectUri: string }
): Promise<{ id_token: string; access_token: string }> {
  const res = await fetch(`${normalizeIssuer(config.issuer)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
      code_verifier: params.codeVerifier,
    }),
  });

  if (!res.ok) {
    throw new Error(`VNUV ID token exchange failed: ${res.status}`);
  }

  const data = (await res.json()) as { id_token?: string; access_token?: string };
  if (!data.id_token || !data.access_token) {
    throw new Error("VNUV ID token exchange response missing id_token/access_token");
  }

  return { id_token: data.id_token, access_token: data.access_token };
}

// Só confirma que o id_token é autêntico (assinatura/issuer/audience) e extrai o `sub` — o
// oidc-provider, seguindo a spec OIDC à risca, não embute email/name no id_token do fluxo
// authorization_code (isso é só pros claims "essenciais": sub/iss/aud/exp). Os dados de perfil
// pedidos via scope (email, name) só vêm mesmo do /userinfo (fetchVnuvIdUserinfo).
export async function verifyVnuvIdToken(
  config: Pick<VnuvIdConfig, "issuer" | "clientId">,
  idToken: string
): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(idToken, getJwks(config.issuer), {
    issuer: normalizeIssuer(config.issuer),
    audience: config.clientId,
  });

  const sub = payload.sub;
  if (!sub) {
    throw new Error("VNUV ID token missing sub claim");
  }

  return { sub };
}

export async function fetchVnuvIdUserinfo(
  config: Pick<VnuvIdConfig, "issuer">,
  accessToken: string
): Promise<VnuvIdProfile> {
  const res = await fetch(`${normalizeIssuer(config.issuer)}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`VNUV ID userinfo request failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (!data.sub || !data.email) {
    throw new Error("VNUV ID userinfo missing sub/email");
  }

  return {
    sub: data.sub,
    email: data.email.trim().toLowerCase(),
    emailVerified: data.email_verified === true,
    name: data.name,
  };
}

export { timingSafeEqualStr } from "./crypto-web.js";
