import { describe, expect, test } from "bun:test";

import {
  GitHubAuthenticator,
  SystemCredentialStore,
  type CredentialStore,
} from "../src/auth";
import type { StoredCredential } from "../src/schemas";

class MemoryCredentialStore implements CredentialStore {
  credential: StoredCredential | null = null;
  deletions = 0;

  get() {
    return Promise.resolve(this.credential);
  }

  set(credential: StoredCredential) {
    this.credential = credential;
    return Promise.resolve();
  }

  delete() {
    this.credential = null;
    this.deletions += 1;
    return Promise.resolve();
  }
}

class MemoryKeyringEntry {
  password: string | undefined;
  deletions = 0;

  getPassword() {
    return Promise.resolve(this.password);
  }

  setPassword(password: string) {
    this.password = password;
    return Promise.resolve();
  }

  deleteCredential() {
    this.password = undefined;
    this.deletions += 1;
    return Promise.resolve(true);
  }
}

function silentIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
    stdout,
    stderr,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("autenticação GitHub", () => {
  test("serializa a sessão somente no keyring nativo", async () => {
    const entry = new MemoryKeyringEntry();
    const store = new SystemCredentialStore(entry);
    const credential: StoredCredential = {
      schemaVersion: 1,
      accessToken: "ghu_acesso",
      expiresAt: "2026-08-11T12:00:00.000Z",
      refreshToken: "ghr_refresh",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };

    await store.set(credential);
    expect(JSON.parse(entry.password ?? "") as unknown).toEqual(credential);
    expect(await store.get()).toEqual(credential);

    await store.delete();
    expect(entry.password).toBeUndefined();
    expect(entry.deletions).toBe(1);
  });

  test("descarta uma sessão inválida encontrada no keyring", async () => {
    const entry = new MemoryKeyringEntry();
    entry.password = '{"token":"inválido"}';
    const store = new SystemCredentialStore(entry);

    expect(await store.get()).toBeNull();
    expect(entry.password).toBeUndefined();
    expect(entry.deletions).toBe(1);
  });

  test("prioriza GH_TOKEN sem persistir ou exibir o valor", async () => {
    const store = new MemoryCredentialStore();
    const capture = silentIo();
    const authenticator = new GitHubAuthenticator(capture.io, {
      credentialStore: store,
      environment: { GH_TOKEN: "ghu_efemero" },
    });

    expect(await authenticator.resolveToken()).toEqual({
      token: "ghu_efemero",
      source: "environment",
    });
    expect(store.credential).toBeNull();
    expect(capture.stdout).toEqual([]);
  });

  test("resolução silenciosa sem sessão não inicia Device Flow", async () => {
    const store = new MemoryCredentialStore();
    const capture = silentIo();
    let requests = 0;
    let browserCalls = 0;
    const authenticator = new GitHubAuthenticator(capture.io, {
      credentialStore: store,
      fetcher: () => {
        requests += 1;
        return Promise.resolve(jsonResponse({}));
      },
      openBrowser: () => {
        browserCalls += 1;
      },
      environment: {},
    });

    expect(await authenticator.resolveTokenSilently()).toBeNull();
    expect(requests).toBe(0);
    expect(browserCalls).toBe(0);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
  });

  test("resolução silenciosa reutiliza GH_TOKEN sem persistir", async () => {
    const store = new MemoryCredentialStore();
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      environment: { GH_TOKEN: "ghu_silencioso" },
    });

    expect(await authenticator.resolveTokenSilently()).toEqual({
      token: "ghu_silencioso",
      source: "environment",
    });
    expect(store.credential).toBeNull();
  });

  test("resolução silenciosa reutiliza access token válido sem rede", async () => {
    const store = new MemoryCredentialStore();
    store.credential = {
      schemaVersion: 1,
      accessToken: "ghu_valido",
      expiresAt: "2026-08-11T14:00:00.000Z",
      refreshToken: "ghr_valido",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    let requests = 0;
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      fetcher: () => {
        requests += 1;
        return Promise.resolve(jsonResponse({}));
      },
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      environment: {},
    });

    expect(await authenticator.resolveTokenSilently()).toEqual({
      token: "ghu_valido",
      source: "keychain",
    });
    expect(requests).toBe(0);
  });

  test("resolução silenciosa renova token e encaminha cancelamento", async () => {
    const store = new MemoryCredentialStore();
    store.credential = {
      schemaVersion: 1,
      accessToken: "ghu_expirado",
      expiresAt: "2026-08-11T11:00:00.000Z",
      refreshToken: "ghr_valido",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      fetcher: (_input, init) => {
        receivedSignal = init?.signal;
        return Promise.resolve(
          jsonResponse({
            access_token: "ghu_renovado",
            expires_in: 28_800,
            refresh_token: "ghr_renovado",
            refresh_token_expires_in: 15_897_600,
            token_type: "bearer",
          }),
        );
      },
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      environment: {},
    });

    expect(await authenticator.resolveTokenSilently(controller.signal)).toEqual(
      {
        token: "ghu_renovado",
        source: "keychain",
      },
    );
    expect(receivedSignal).toBe(controller.signal);
    expect(store.credential).toMatchObject({
      accessToken: "ghu_renovado",
      refreshToken: "ghr_renovado",
    });
  });

  test("resolução silenciosa remove refresh expirado ou inválido", async () => {
    const store = new MemoryCredentialStore();
    store.credential = {
      schemaVersion: 1,
      accessToken: "ghu_expirado",
      expiresAt: "2026-08-11T10:00:00.000Z",
      refreshToken: "ghr_expirado",
      refreshExpiresAt: "2026-08-11T11:00:00.000Z",
    };
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      environment: {},
    });

    expect(await authenticator.resolveTokenSilently()).toBeNull();
    expect(store.deletions).toBe(1);

    store.credential = {
      schemaVersion: 1,
      accessToken: "ghu_expirado",
      expiresAt: "2026-08-11T10:00:00.000Z",
      refreshToken: "ghr_invalido",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    const invalidRefresh = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      fetcher: () => Promise.resolve(jsonResponse({ error: "bad_refresh" })),
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      environment: {},
    });

    expect(await invalidRefresh.resolveTokenSilently()).toBeNull();
    expect(store.deletions).toBe(2);
  });

  test("resolução silenciosa degrada quando o keychain está indisponível", async () => {
    const capture = silentIo();
    const store: CredentialStore = {
      get: () => Promise.reject(new Error("keychain indisponível")),
      set: () => Promise.reject(new Error("keychain indisponível")),
      delete: () => Promise.reject(new Error("keychain indisponível")),
    };
    const authenticator = new GitHubAuthenticator(capture.io, {
      credentialStore: store,
      environment: {},
    });

    expect(await authenticator.resolveTokenSilently()).toBeNull();
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
  });

  test("resolução silenciosa preserva credencial em abort transitório", async () => {
    const store = new MemoryCredentialStore();
    store.credential = {
      schemaVersion: 1,
      accessToken: "ghu_expirado",
      expiresAt: "2026-08-11T10:00:00.000Z",
      refreshToken: "ghr_preservado",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    const original = store.credential;
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      fetcher: () => Promise.reject(new DOMException("abortado", "AbortError")),
      now: () => new Date("2026-08-11T12:00:00.000Z"),
      environment: {},
    });

    try {
      await authenticator.resolveTokenSilently();
      throw new Error("O refresh abortado deveria falhar.");
    } catch (error) {
      expect(error).toMatchObject({ exitCode: 4 });
    }
    expect(store.credential).toEqual(original);
    expect(store.deletions).toBe(0);
  });

  test("renova token do Device Flow sem client secret", async () => {
    const store = new MemoryCredentialStore();
    store.credential = {
      schemaVersion: 1,
      accessToken: "ghu_expirado",
      expiresAt: "2026-08-07T11:00:00.000Z",
      refreshToken: "ghr_valido",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };
    let submittedBody = "";
    const fetcher = (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      submittedBody =
        body instanceof URLSearchParams
          ? body.toString()
          : typeof body === "string"
            ? body
            : "";
      return Promise.resolve(
        jsonResponse({
          access_token: "ghu_novo",
          expires_in: 28_800,
          refresh_token: "ghr_novo",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
        }),
      );
    };
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      fetcher,
      now: () => new Date("2026-08-07T12:00:00.000Z"),
      environment: {},
    });

    expect(await authenticator.resolveToken()).toEqual({
      token: "ghu_novo",
      source: "keychain",
    });
    expect(submittedBody).toContain("grant_type=refresh_token");
    expect(submittedBody).toContain("refresh_token=ghr_valido");
    expect(submittedBody).not.toContain("client_secret");
    expect(store.credential).toMatchObject({ accessToken: "ghu_novo" });
  });

  test("conclui Device Flow e salva somente no cofre", async () => {
    const store = new MemoryCredentialStore();
    const capture = silentIo();
    const responses = [
      {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 1,
      },
      { error: "authorization_pending" },
      {
        access_token: "ghu_autorizado",
        expires_in: 28_800,
        refresh_token: "ghr_autorizado",
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
      },
    ];
    let currentTime = Date.parse("2026-08-07T12:00:00.000Z");
    let opened = "";
    const fetcher = () => Promise.resolve(jsonResponse(responses.shift()));
    const authenticator = new GitHubAuthenticator(capture.io, {
      credentialStore: store,
      fetcher,
      now: () => new Date(currentTime),
      sleep: (milliseconds) => {
        currentTime += milliseconds;
        return Promise.resolve();
      },
      openBrowser: (url) => {
        opened = url;
      },
      environment: {},
    });

    expect(await authenticator.resolveToken()).toEqual({
      token: "ghu_autorizado",
      source: "device-flow",
    });
    expect(opened).toBe("https://github.com/login/device");
    expect(capture.stdout[0]).toContain("ABCD-EFGH");
    expect(capture.stdout.join(" ")).not.toContain("ghu_autorizado");
    expect(store.credential?.refreshToken).toBe("ghr_autorizado");
  });

  test("remove a sessão do cofre", async () => {
    const store = new MemoryCredentialStore();
    const authenticator = new GitHubAuthenticator(silentIo().io, {
      credentialStore: store,
      environment: {},
    });
    await authenticator.logout();
    expect(store.deletions).toBe(1);
  });
});
