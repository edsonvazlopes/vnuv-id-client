import type { VnuvIdConfig, VnuvIdProfile } from "./protocol.js";
import {
  exchangeCodeForTokens,
  fetchVnuvIdUserinfo,
  verifyVnuvIdToken,
} from "./protocol.js";

export const VNUV_PROVIDER = "vnuv" as const;

export type MfaRequirement = {
  /** Token opaco que o app usa pra amarrar a próxima etapa do desafio de MFA à conta certa. */
  challengeToken: string;
};

export interface VnuvIdAdapter<TUser = unknown> {
  findExternalIdentity(providerSub: string): Promise<{ userId: string } | null>;
  findUserById(userId: string): Promise<TUser | null>;
  findUserByEmail(email: string): Promise<TUser | null>;
  /** Vincula um usuário já existente à identidade externa — nunca cria conta nova aqui. */
  createExternalIdentity(user: TUser, providerSub: string, email: string): Promise<void>;
  createUserWithExternalIdentity(email: string, providerSub: string): Promise<TUser>;
  markUserEmailVerified(user: TUser): Promise<void>;
  isAccountLocked(user: TUser): Promise<boolean> | boolean;
  /** null = sem MFA habilitado, ou já satisfeito (ex.: adapter reconheceu dispositivo de confiança). */
  getMfaRequirement(user: TUser): Promise<MfaRequirement | null> | MfaRequirement | null;
  createSession(user: TUser, opts: { remember: boolean }): Promise<void>;
  /** Hook opcional pra auditoria/e-mails/efeitos colaterais de negócio. Nunca bloqueia o fluxo. */
  onAuthEvent?(event: VnuvIdAuthEvent<TUser>): void | Promise<void>;
}

export type VnuvIdAuthEvent<TUser> =
  | { type: "signup"; user: TUser }
  | { type: "linked"; user: TUser }
  | { type: "login"; user: TUser }
  | { type: "account_locked"; user: TUser }
  | { type: "mfa_required"; user: TUser };

export type VnuvIdLoginResult<TUser> =
  | { ok: true; user: TUser; event: "login" | "signup" | "linked" }
  | { ok: false; code: "ACCOUNT_LOCKED" }
  | { ok: false; code: "MFA_REQUIRED"; mfa: MfaRequirement };

async function emit<TUser>(adapter: VnuvIdAdapter<TUser>, event: VnuvIdAuthEvent<TUser>) {
  try {
    await adapter.onAuthEvent?.(event);
  } catch {
    // onAuthEvent é só efeito colateral (audit log, e-mail) — nunca deve derrubar o login.
  }
}

/**
 * Política de auto-vínculo/criação de conta + gate de MFA, idêntica em todo app do ecossistema.
 * Não decide sessão nem UI — isso é responsabilidade do adapter (createSession) e do app chamador.
 */
export async function completeVnuvIdLogin<TUser>(
  profile: VnuvIdProfile,
  adapter: VnuvIdAdapter<TUser>,
  opts: { remember?: boolean } = {}
): Promise<VnuvIdLoginResult<TUser>> {
  const existingIdentity = await adapter.findExternalIdentity(profile.sub);
  let user = existingIdentity ? await adapter.findUserById(existingIdentity.userId) : null;
  let event: "login" | "signup" | "linked" = "login";

  if (!user) {
    const existingByEmail = await adapter.findUserByEmail(profile.email);

    if (existingByEmail) {
      // Vínculo automático por e-mail: confia no email_verified do VNUV ID em vez de
      // bloquear o login ou pedir confirmação extra (mesma política em todo app cliente).
      await adapter.createExternalIdentity(existingByEmail, profile.sub, profile.email);
      if (profile.emailVerified) {
        await adapter.markUserEmailVerified(existingByEmail);
      }
      user = existingByEmail;
      event = "linked";
    } else {
      user = await adapter.createUserWithExternalIdentity(profile.email, profile.sub);
      event = "signup";
    }
  }

  if (await adapter.isAccountLocked(user)) {
    await emit(adapter, { type: "account_locked", user });
    return { ok: false, code: "ACCOUNT_LOCKED" };
  }

  // Gate de MFA nunca é pulado, independente de como a pessoa se autenticou no VNUV ID.
  const mfa = await adapter.getMfaRequirement(user);
  if (mfa) {
    await emit(adapter, { type: "mfa_required", user });
    return { ok: false, code: "MFA_REQUIRED", mfa };
  }

  await adapter.createSession(user, { remember: opts.remember ?? false });
  await emit(adapter, { type: event, user });

  return { ok: true, user, event };
}

export type VnuvIdCallbackParams = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

/**
 * Atalho pro caso comum: troca o code, verifica o id_token, busca o userinfo, confere que o
 * sub bate nos dois passos, rejeita e-mail não verificado, e delega pra completeVnuvIdLogin.
 * Apps com fluxo adicional que precisa do `sub` verificado antes de decidir o que fazer (ex.:
 * reautenticação de usuário já logado) devem chamar exchangeCodeForTokens/verifyVnuvIdToken/
 * fetchVnuvIdUserinfo separadamente em vez deste atalho.
 */
export async function handleVnuvIdCallback<TUser>(
  config: VnuvIdConfig,
  params: VnuvIdCallbackParams,
  adapter: VnuvIdAdapter<TUser>,
  opts: { remember?: boolean } = {}
): Promise<VnuvIdLoginResult<TUser> | { ok: false; code: "EMAIL_UNVERIFIED" }> {
  const { id_token, access_token } = await exchangeCodeForTokens(config, {
    code: params.code,
    codeVerifier: params.codeVerifier,
    redirectUri: params.redirectUri,
  });

  const { sub } = await verifyVnuvIdToken(config, id_token);
  const profile = await fetchVnuvIdUserinfo(config, access_token);

  if (profile.sub !== sub) {
    throw new Error("VNUV ID userinfo sub não bate com o sub do id_token verificado");
  }

  if (!profile.emailVerified) {
    return { ok: false, code: "EMAIL_UNVERIFIED" };
  }

  return completeVnuvIdLogin(profile, adapter, opts);
}
