# JeraSoft Brand CLI

CLI público responsável por autenticar, resolver, validar e materializar
contratos e ativos privados da plataforma de marca JeraSoft.

O pacote contém somente o protocolo de transporte. Conteúdo de marca não é
publicado no npm e continua protegido no repositório corporativo canônico.

## Interface prevista

```sh
bunx --bun @jerasoft/brand@latest init
bunx --bun @jerasoft/brand@1 context --profile=apply --format=markdown
bunx --bun @jerasoft/brand@1 asset resolve <id> --copy-to <destino>
bunx --bun @jerasoft/brand@1 audit --frozen --offline
```

O repositório está em implementação e o pacote ainda não foi publicado. A
versão `1.0.0` somente será liberada quando autenticação, cache, integridade,
bootstrap e auditoria offline passarem pelo protocolo completo. Enquanto isso,
`private: true` bloqueia qualquer publicação npm acidental.

## Desenvolvimento

```sh
bun ci
bun run check
```

O tarball é limitado a `README.md`, `package.json` e `dist/cli.js`. Não existem
hooks de instalação nem credenciais persistentes no pacote.
