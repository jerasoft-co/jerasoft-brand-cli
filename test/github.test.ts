import { describe, expect, test } from "bun:test";

import { EXIT_CODES } from "../src/constants";
import { GitHubClient } from "../src/github";

describe("cliente GitHub", () => {
  test("remove autorização ao seguir URL assinada aprovada", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetcher = (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") });
      if (requests.length === 1) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: {
              Location:
                "https://objects.githubusercontent.com/private/signed?sig=valor",
            },
          }),
        );
      }
      return Promise.resolve(new Response("arquivo"));
    };

    const contents = await new GitHubClient(fetcher).downloadAsset(
      "ghu_secreto",
      123,
    );
    expect(new TextDecoder().decode(contents)).toBe("arquivo");
    expect(requests[0]?.authorization).toBe("Bearer ghu_secreto");
    expect(requests[1]?.authorization).toBeNull();
  });

  test("rejeita redirect para host não aprovado", async () => {
    const client = new GitHubClient(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/roubo" },
        }),
      ),
    );
    try {
      await client.downloadAsset("ghu_secreto", 123);
      throw new Error("O download deveria ter sido rejeitado.");
    } catch (error) {
      expect(error).toMatchObject({
        exitCode: EXIT_CODES.integrity,
        retryable: false,
      });
    }
  });
});
