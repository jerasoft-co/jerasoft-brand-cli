# Regras de implementação — JeraSoft Brand CLI

Este repositório é público e contém somente o mecanismo de transporte da
plataforma de marca. Nenhum contrato privado, skill completa, logo, fonte,
screenshot, catálogo de ativos ou credencial pode ser adicionado aqui.

## Fronteira de segurança

- O repositório privado canônico é `jerasoft-co/portfolio-jerasoft`.
- O pacote npm é `@jerasoft/brand`; o owner GitHub e o scope npm são
  intencionalmente diferentes.
- Client IDs são públicos. Client secrets, private keys, tokens e URLs
  autenticadas nunca entram em código, fixture, log, receipt ou tarball.
- Não use hooks `postinstall`, `prepare`, `preinstall` ou equivalentes.
- O tarball deve ser montado por allowlist e passar por `bun run pack:check`.
- Downloads privados devem partir exclusivamente de IDs e URLs retornados pela
  API oficial do GitHub, com host validado e digest SHA-256 conferido.

## Stack e qualidade

- Bun fixado como runtime, gerenciador, test runner e bundler.
- TypeScript strict, ESLint flat config e Prettier.
- Mensagens exibidas ao usuário em português do Brasil.
- Dependências com versão exata e `bun.lock` versionado.
- Testes para parser, schemas, integridade, cache, autenticação, escrita
  atômica, traversal, symlink, redaction e tarball.
- Execute `bun run check` antes de commit, push, tag ou publicação.

## Publicação

- Releases usam tags `v<semver>` e devem corresponder à versão do
  `package.json`.
- Depois do bootstrap de `1.0.0`, publicação npm ocorre apenas no workflow
  `publish.yml`, em runner hospedado pelo GitHub, com Trusted Publisher OIDC e
  environment `npm-production`.
- A única exceção é a primeira publicação do pacote, porque o npm exige que o
  pacote exista antes de permitir o cadastro do Trusted Publisher. Ela deve
  partir de `main`, após todos os gates, com login web local e logout imediato.
- Não use token npm persistente nem armazene token em GitHub Actions.
- A versão `1.0.0` só pode ser publicada após `init`, `context`, resolução de
  ativos, cache, autenticação e auditoria offline cumprirem o protocolo v1.
- Mantenha `private: true` no `package.json` durante a implementação. Remova a
  trava somente no mesmo change set que comprovar todos os critérios de release.
- Siga `docs/RELEASING.md` para bootstrap, tags e releases subsequentes.
