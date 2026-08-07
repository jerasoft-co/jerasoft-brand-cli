import { describe, expect, test } from "bun:test";

import { GitHubAuthenticator, type CredentialStore } from "../src/auth";
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
