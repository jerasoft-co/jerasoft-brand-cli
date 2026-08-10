import { spawn } from "node:child_process";

import { z } from "zod";

import {
  CREDENTIAL_NAME,
  CREDENTIAL_SERVICE,
  EXIT_CODES,
  GITHUB_APP_CLIENT_ID,
  GITHUB_WEB_ORIGIN,
  TOKEN_EXPIRY_SKEW_MS,
} from "./constants";
import { CliError } from "./errors";
import { storedCredentialSchema, type StoredCredential } from "./schemas";

type HttpFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const deviceAuthorizationSchema = z
  .object({
    device_code: z.string().min(1),
    user_code: z.string().min(1),
    verification_uri: z.literal("https://github.com/login/device"),
    expires_in: z.number().int().positive(),
    interval: z.number().int().positive(),
  })
  .loose();

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1),
    refresh_token_expires_in: z.number().int().positive(),
    token_type: z.string().min(1),
  })
  .loose();

const oauthPendingSchema = z
  .object({
    error: z.string().min(1),
    interval: z.number().int().positive().optional(),
  })
  .loose();

export interface CredentialStore {
  get(): Promise<StoredCredential | null>;
  set(credential: StoredCredential): Promise<void>;
  delete(): Promise<void>;
}

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

async function createSystemKeyringEntry(): Promise<KeyringEntry> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(CREDENTIAL_SERVICE, CREDENTIAL_NAME);
}

export class SystemCredentialStore implements CredentialStore {
  private entryPromise: Promise<KeyringEntry> | undefined;

  constructor(private readonly injectedEntry?: KeyringEntry) {}

  private resolveEntry() {
    if (this.injectedEntry) return Promise.resolve(this.injectedEntry);
    this.entryPromise ??= createSystemKeyringEntry();
    return this.entryPromise;
  }

  async get() {
    const entry = await this.resolveEntry();
    const serialized = await entry.getPassword();
    if (!serialized) return null;
    try {
      return storedCredentialSchema.parse(JSON.parse(serialized) as unknown);
    } catch {
      await this.delete();
      return null;
    }
  }

  async set(credential: StoredCredential) {
    const entry = await this.resolveEntry();
    await entry.setPassword(
      JSON.stringify(storedCredentialSchema.parse(credential)),
    );
  }

  async delete() {
    const entry = await this.resolveEntry();
    await entry.deleteCredential();
  }
}

interface AuthIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface AuthOptions {
  credentialStore?: CredentialStore;
  fetcher?: HttpFetcher;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  environment?: Record<string, string | undefined>;
}

export interface ResolvedToken {
  token: string;
  source: "environment" | "keychain" | "device-flow";
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function defaultOpenBrowser(url: string) {
  if (process.env.JERASOFT_BRAND_NO_BROWSER === "1") return;
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const [executable, ...arguments_] = command;
    if (!executable) return;
    const child = spawn(executable, arguments_, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    child.unref();
  } catch {
    // A URL e o código já foram exibidos; abrir o navegador é conveniência.
  }
}

async function postOAuth(
  fetcher: HttpFetcher,
  pathname: string,
  parameters: Record<string, string>,
) {
  let response: Response;
  try {
    response = await fetcher(`${GITHUB_WEB_ORIGIN}${pathname}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    });
  } catch (error) {
    throw new CliError(
      "Não foi possível conectar ao GitHub para autenticar.",
      EXIT_CODES.networkWithoutCache,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new CliError(
      `O GitHub recusou a autenticação com HTTP ${String(response.status)}.`,
      EXIT_CODES.authentication,
    );
  }
  return response.json();
}

function toCredential(
  response: z.infer<typeof tokenResponseSchema>,
  now: Date,
): StoredCredential {
  return storedCredentialSchema.parse({
    schemaVersion: 1,
    accessToken: response.access_token,
    expiresAt: new Date(
      now.getTime() + response.expires_in * 1000,
    ).toISOString(),
    refreshToken: response.refresh_token,
    refreshExpiresAt: new Date(
      now.getTime() + response.refresh_token_expires_in * 1000,
    ).toISOString(),
  });
}

export class GitHubAuthenticator {
  private readonly credentialStore: CredentialStore;
  private readonly fetcher: HttpFetcher;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly openBrowser: (url: string) => void;
  private readonly environment: Record<string, string | undefined>;

  constructor(
    private readonly io: AuthIo,
    options: AuthOptions = {},
  ) {
    this.credentialStore =
      options.credentialStore ?? new SystemCredentialStore();
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.openBrowser = options.openBrowser ?? defaultOpenBrowser;
    this.environment = options.environment ?? process.env;
  }

  async resolveToken(): Promise<ResolvedToken> {
    const environmentToken = this.environment.GH_TOKEN?.trim();
    if (environmentToken) {
      return { token: environmentToken, source: "environment" };
    }

    let stored: StoredCredential | null = null;
    try {
      stored = await this.credentialStore.get();
    } catch {
      this.io.stderr(
        "O cofre seguro do sistema não pôde ser consultado; a sessão não será reutilizada.",
      );
    }

    if (stored) {
      const now = this.now().getTime();
      if (Date.parse(stored.expiresAt) - TOKEN_EXPIRY_SKEW_MS > now) {
        return { token: stored.accessToken, source: "keychain" };
      }
      if (Date.parse(stored.refreshExpiresAt) > now) {
        try {
          const refreshed = await this.refresh(stored.refreshToken);
          await this.persistBestEffort(refreshed);
          return { token: refreshed.accessToken, source: "keychain" };
        } catch (error) {
          if (
            error instanceof CliError &&
            error.exitCode === EXIT_CODES.networkWithoutCache
          ) {
            throw error;
          }
          await this.deleteBestEffort();
        }
      } else {
        await this.deleteBestEffort();
      }
    }

    if (this.environment.CI === "true") {
      throw new CliError(
        "Autenticação interativa indisponível no CI. Forneça GH_TOKEN efêmero.",
        EXIT_CODES.authentication,
      );
    }
    const credential = await this.deviceFlow();
    await this.persistBestEffort(credential);
    return { token: credential.accessToken, source: "device-flow" };
  }

  async logout() {
    await this.deleteBestEffort();
  }

  private async refresh(refreshToken: string) {
    const response = tokenResponseSchema.safeParse(
      await postOAuth(this.fetcher, "/login/oauth/access_token", {
        client_id: GITHUB_APP_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
    if (!response.success) {
      throw new CliError(
        "A sessão do GitHub expirou e precisa ser autenticada novamente.",
        EXIT_CODES.authentication,
      );
    }
    return toCredential(response.data, this.now());
  }

  private async deviceFlow() {
    const authorization = deviceAuthorizationSchema.safeParse(
      await postOAuth(this.fetcher, "/login/device/code", {
        client_id: GITHUB_APP_CLIENT_ID,
      }),
    );
    if (!authorization.success) {
      throw new CliError(
        "O GitHub não iniciou o Device Flow esperado.",
        EXIT_CODES.authentication,
      );
    }

    this.io.stdout(
      `Abra ${authorization.data.verification_uri} e informe o código ${authorization.data.user_code}.`,
    );
    this.openBrowser(authorization.data.verification_uri);

    const deadline =
      this.now().getTime() + authorization.data.expires_in * 1000;
    let intervalSeconds = authorization.data.interval;
    while (this.now().getTime() < deadline) {
      await this.sleep(intervalSeconds * 1000);
      const raw = await postOAuth(this.fetcher, "/login/oauth/access_token", {
        client_id: GITHUB_APP_CLIENT_ID,
        device_code: authorization.data.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const token = tokenResponseSchema.safeParse(raw);
      if (token.success) return toCredential(token.data, this.now());

      const pending = oauthPendingSchema.safeParse(raw);
      if (!pending.success) break;
      if (pending.data.error === "authorization_pending") continue;
      if (pending.data.error === "slow_down") {
        intervalSeconds = pending.data.interval ?? intervalSeconds + 5;
        continue;
      }
      if (pending.data.error === "access_denied") {
        throw new CliError(
          "A autorização foi cancelada no GitHub.",
          EXIT_CODES.authentication,
        );
      }
      break;
    }
    throw new CliError(
      "O código de autenticação expirou. Execute o comando novamente.",
      EXIT_CODES.authentication,
    );
  }

  private async persistBestEffort(credential: StoredCredential) {
    try {
      await this.credentialStore.set(credential);
    } catch {
      this.io.stderr(
        "Autenticado, mas o cofre seguro não armazenou a sessão; um novo login poderá ser solicitado.",
      );
    }
  }

  private async deleteBestEffort() {
    try {
      await this.credentialStore.delete();
    } catch {
      throw new CliError(
        "Não foi possível remover a sessão do cofre seguro do sistema.",
        EXIT_CODES.authentication,
      );
    }
  }
}
