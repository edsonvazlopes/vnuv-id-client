import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeCodeForTokens,
  fetchVnuvIdUserinfo,
  timingSafeEqualStr,
  verifyVnuvIdToken,
} from "../src/protocol.js";

const config = {
  issuer: "https://id.vnuv.net/api/oidc",
  clientId: "cli_test",
  clientSecret: "secret_test",
};

describe("createPkcePair", () => {
  it("gera verifier e challenge S256 correspondentes", async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge.length).toBeGreaterThan(20);
    // challenge é determinístico a partir do verifier
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("gera pares diferentes a cada chamada", async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("createState", () => {
  it("gera strings não vazias e diferentes entre chamadas", () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });
});

describe("timingSafeEqualStr", () => {
  it("compara igualdade corretamente", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "ab")).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("monta a URL de autorização com PKCE e scope padrão", () => {
    const url = buildAuthorizeUrl(config, {
      state: "state123",
      codeChallenge: "challenge123",
      redirectUri: "https://app.vnuv.net/api/auth/vnuv-id/callback",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://id.vnuv.net/api/oidc/auth");
    expect(parsed.searchParams.get("client_id")).toBe("cli_test");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("openid email profile");
    expect(parsed.searchParams.get("state")).toBe("state123");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge123");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("aceita scope customizado", () => {
    const url = buildAuthorizeUrl(config, {
      state: "s",
      codeChallenge: "c",
      redirectUri: "https://app.vnuv.net/callback",
      scope: "openid email",
    });
    expect(new URL(url).searchParams.get("scope")).toBe("openid email");
  });
});

describe("exchangeCodeForTokens", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("troca o code por tokens com sucesso", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id_token: "idt", access_token: "at" }), { status: 200 })
    );

    const result = await exchangeCodeForTokens(config, {
      code: "code123",
      codeVerifier: "verifier123",
      redirectUri: "https://app.vnuv.net/callback",
    });

    expect(result).toEqual({ id_token: "idt", access_token: "at" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://id.vnuv.net/api/oidc/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier123");
    expect(body.get("client_secret")).toBe("secret_test");
  });

  it("lança erro se a resposta não for ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response("fail", { status: 400 }));
    await expect(
      exchangeCodeForTokens(config, { code: "c", codeVerifier: "v", redirectUri: "r" })
    ).rejects.toThrow(/token exchange failed/);
  });

  it("lança erro se faltar id_token/access_token na resposta", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      exchangeCodeForTokens(config, { code: "c", codeVerifier: "v", redirectUri: "r" })
    ).rejects.toThrow(/missing id_token/);
  });
});

describe("fetchVnuvIdUserinfo", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("busca e normaliza o perfil", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sub: "usr_123",
          email: "  Pessoa@Example.com  ",
          email_verified: true,
          name: "Pessoa",
        }),
        { status: 200 }
      )
    );

    const profile = await fetchVnuvIdUserinfo(config, "access-token");
    expect(profile).toEqual({
      sub: "usr_123",
      email: "pessoa@example.com",
      emailVerified: true,
      name: "Pessoa",
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer access-token");
  });

  it("lança erro se faltar sub/email", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sub: "usr_1" }), { status: 200 }));
    await expect(fetchVnuvIdUserinfo(config, "at")).rejects.toThrow(/missing sub\/email/);
  });
});

describe("verifyVnuvIdToken", () => {
  it("propaga erro quando o token é inválido/não verificável", async () => {
    await expect(
      verifyVnuvIdToken(config, "not-a-real-jwt")
    ).rejects.toThrow();
  });
});
