# JeraSoft Brand CLI

CLI público que autentica, resolve, valida e materializa contratos, skills e
ativos privados da plataforma de marca JeraSoft. O pacote contém somente o
protocolo de transporte; o conteúdo protegido permanece no repositório
corporativo canônico.

## Uso

Inicialize uma única vez na raiz de cada projeto:

```sh
bunx --bun @jerasoft/brand@latest init
```

O comando cria:

- `.jerasoft/brand.json`, com a política versionada do projeto;
- `.jerasoft/brand.lock.json`, com a resolução e os digests aprovados;
- um bloco gerenciado em `AGENTS.md`;
- três skills finas em `.agents/skills`, quando o adapter Codex for detectado
  ou solicitado.

O bootstrap fixa `@1`, permitindo atualizações patch e minor compatíveis sem
migrar silenciosamente para outro major.

### Contexto para agentes

```sh
bunx --bun @jerasoft/brand@1 context --profile=apply --format=markdown
bunx --bun @jerasoft/brand@1 context --profile=audit --format=json
bunx --bun @jerasoft/brand@1 context --profile=assets --fresh
```

Os perfis retornam o contrato vigente e o procedimento privado correspondente.
O perfil `assets` também lista os IDs aprovados e seus digests.

### Materializar um ativo

O destino precisa ficar dentro de `assetDirectory`, configurado por padrão como
`assets/brand`:

```sh
bunx --bun @jerasoft/brand@1 asset resolve \
  logo.jerasoft.symbol.default \
  --copy-to=assets/brand/jerasoft-symbol.svg
```

O CLI não sobrescreve um arquivo divergente e rejeita traversal e links
simbólicos.

### Sincronização, auditoria e migração

```sh
bunx --bun @jerasoft/brand@1 sync
bunx --bun @jerasoft/brand@1 audit --frozen
bunx --bun @jerasoft/brand@1 audit --frozen --offline
bunx --bun @jerasoft/brand@1 upgrade --major
```

`context` nunca modifica o lock. Somente `init`, `sync`, `upgrade` e a resolução
de um ativo registram uma nova resolução no projeto.

## Autenticação

A ordem é:

1. `GH_TOKEN`, apenas como override efêmero para CI ou execução headless;
2. token do Device Flow armazenado no cofre seguro do sistema;
3. novo Device Flow interativo da GitHub App `JeraSoft Brand Resolver`.

Tokens de acesso expiram e são renovados pelo refresh token sem client secret.
Nenhum token é salvo no projeto, no cache, no receipt ou no pacote npm.

```sh
bunx --bun @jerasoft/brand@1 logout
bunx --bun @jerasoft/brand@1 logout --purge-cache
```

## Cache e integridade

- o manifesto é consultado com ETag;
- arquivos são baixados individualmente por IDs retornados pela API oficial;
- o manifesto é conferido contra o SHA-256 da API do GitHub;
- cada payload é conferido contra a API e o manifesto;
- falhas de rede ou `5xx` podem usar cache íntegro de até 30 dias;
- `401` e `403` sempre falham sem fallback;
- `--fresh` exige validação remota;
- receipts ficam apenas no cache local e não contêm conteúdo ou credenciais.

## Desenvolvimento

```sh
bun ci
bun run check
```

O tarball é limitado a `README.md`, `package.json` e `dist/cli.js`. Não existem
hooks de instalação, client secrets, chaves privadas ou conteúdo de marca no
pacote público.
