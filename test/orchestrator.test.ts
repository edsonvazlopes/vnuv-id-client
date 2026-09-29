import { describe, expect, it, vi } from "vitest";
import {
  VNUV_PROVIDER,
  completeVnuvIdLogin,
  type MfaRequirement,
  type VnuvIdAdapter,
  type VnuvIdAuthEvent,
} from "../src/orchestrator.js";
import type { VnuvIdProfile } from "../src/protocol.js";

type FakeUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  lockedUntil: Date | null;
  mfaEnabled: boolean;
};

function makeProfile(overrides: Partial<VnuvIdProfile> = {}): VnuvIdProfile {
  return {
    sub: "sub-1",
    email: "pessoa@example.com",
    emailVerified: true,
    ...overrides,
  };
}

class FakeAdapter implements VnuvIdAdapter<FakeUser> {
  users = new Map<string, FakeUser>();
  identities = new Map<string, string>(); // providerSub -> userId
  sessions: string[] = [];
  events: VnuvIdAuthEvent<FakeUser>[] = [];
  mfaChallengeFor: Set<string> = new Set();

  seedUser(user: FakeUser) {
    this.users.set(user.id, user);
    return user;
  }

  async findExternalIdentity(providerSub: string) {
    const userId = this.identities.get(providerSub);
    return userId ? { userId } : null;
  }

  async findUserById(userId: string) {
    return this.users.get(userId) ?? null;
  }

  async findUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async createExternalIdentity(user: FakeUser, providerSub: string) {
    this.identities.set(providerSub, user.id);
  }

  async createUserWithExternalIdentity(email: string, providerSub: string) {
    const user: FakeUser = {
      id: `user-${this.users.size + 1}`,
      email,
      emailVerifiedAt: new Date(),
      lockedUntil: null,
      mfaEnabled: false,
    };
    this.users.set(user.id, user);
    this.identities.set(providerSub, user.id);
    return user;
  }

  async markUserEmailVerified(user: FakeUser) {
    user.emailVerifiedAt = new Date();
  }

  isAccountLocked(user: FakeUser) {
    return Boolean(user.lockedUntil && user.lockedUntil.getTime() > Date.now());
  }

  getMfaRequirement(user: FakeUser): MfaRequirement | null {
    if (!user.mfaEnabled || this.mfaChallengeFor.has(user.id)) return null;
    return { challengeToken: `challenge-${user.id}` };
  }

  async createSession(user: FakeUser) {
    this.sessions.push(user.id);
  }

  async onAuthEvent(event: VnuvIdAuthEvent<FakeUser>) {
    this.events.push(event);
  }
}

describe("completeVnuvIdLogin", () => {
  it("cria conta nova sem senha quando não existe usuário nem identidade", async () => {
    const adapter = new FakeAdapter();
    const result = await completeVnuvIdLogin(makeProfile(), adapter);

    expect(result).toMatchObject({ ok: true, event: "signup" });
    expect(adapter.users.size).toBe(1);
    expect(adapter.sessions).toEqual([(result as { user: FakeUser }).user.id]);
    expect(adapter.events.map((e) => e.type)).toEqual(["signup", "login"]);
  });

  it("vincula automaticamente por e-mail quando já existe conta local, sem duplicar", async () => {
    const adapter = new FakeAdapter();
    const existing = adapter.seedUser({
      id: "user-existing",
      email: "pessoa@example.com",
      emailVerifiedAt: null,
      lockedUntil: null,
      mfaEnabled: false,
    });

    const result = await completeVnuvIdLogin(makeProfile(), adapter);

    expect(result).toMatchObject({ ok: true, event: "linked" });
    expect(adapter.users.size).toBe(1);
    expect(existing.emailVerifiedAt).not.toBeNull();
    expect(adapter.identities.get("sub-1")).toBe("user-existing");
  });

  it("não cria conta duplicada em logins repetidos com a mesma sub", async () => {
    const adapter = new FakeAdapter();
    await completeVnuvIdLogin(makeProfile(), adapter);
    const second = await completeVnuvIdLogin(makeProfile(), adapter);

    expect(adapter.users.size).toBe(1);
    expect(second).toMatchObject({ ok: true, event: "login" });
  });

  it("rejeita login de conta bloqueada", async () => {
    const adapter = new FakeAdapter();
    adapter.seedUser({
      id: "user-locked",
      email: "pessoa@example.com",
      emailVerifiedAt: new Date(),
      lockedUntil: new Date(Date.now() + 60_000),
      mfaEnabled: false,
    });

    const result = await completeVnuvIdLogin(makeProfile(), adapter);
    expect(result).toEqual({ ok: false, code: "ACCOUNT_LOCKED" });
    expect(adapter.sessions).toEqual([]);
  });

  it("nunca pula o MFA local, mesmo autenticando via VNUV ID", async () => {
    const adapter = new FakeAdapter();
    adapter.seedUser({
      id: "user-mfa",
      email: "pessoa@example.com",
      emailVerifiedAt: new Date(),
      lockedUntil: null,
      mfaEnabled: true,
    });

    const result = await completeVnuvIdLogin(makeProfile(), adapter);
    expect(result).toEqual({
      ok: false,
      code: "MFA_REQUIRED",
      mfa: { challengeToken: "challenge-user-mfa" },
    });
    expect(adapter.sessions).toEqual([]);
  });

  it("emite o evento de vínculo mesmo quando o MFA bloqueia a sessão em seguida", async () => {
    // Replica o comportamento original do Nicho: o alerta de vínculo/audit de conta
    // dispara no momento em que a conta é resolvida, não só quando o login termina
    // com sucesso — senão um e-mail de "sua conta foi vinculada" nunca seria enviado
    // pra quem tem MFA habilitado.
    const adapter = new FakeAdapter();
    adapter.seedUser({
      id: "user-mfa-linked",
      email: "pessoa@example.com",
      emailVerifiedAt: null,
      lockedUntil: null,
      mfaEnabled: true,
    });

    const result = await completeVnuvIdLogin(makeProfile(), adapter);
    expect(result).toMatchObject({ ok: false, code: "MFA_REQUIRED" });
    expect(adapter.events.map((e) => e.type)).toEqual(["linked", "mfa_required"]);
  });

  it("onAuthEvent que lança erro não derruba o login", async () => {
    const adapter = new FakeAdapter();
    adapter.onAuthEvent = vi.fn().mockRejectedValue(new Error("boom"));

    const result = await completeVnuvIdLogin(makeProfile(), adapter);
    expect(result.ok).toBe(true);
  });

  it("expõe VNUV_PROVIDER como constante fixa", () => {
    expect(VNUV_PROVIDER).toBe("vnuv");
  });
});
