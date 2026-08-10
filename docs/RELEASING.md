# Publicação do JeraSoft Brand CLI

## Bootstrap único de `1.0.0`

O npm exige que um pacote exista antes de permitir o cadastro de um Trusted
Publisher. Por isso, somente a primeira versão usa uma sessão local e efêmera:

1. Faça merge do PR aprovado em `main` e use uma árvore limpa e sincronizada.
2. Execute `bun ci` e `bun run check`.
3. Autentique com `npm login --auth-type=web` usando uma conta owner do scope
   `jerasoft`.
4. Publique com
   `npm publish --access public --provenance=false --ignore-scripts`.
5. Execute `npm logout` imediatamente.
6. No pacote `@jerasoft/brand`, cadastre o Trusted Publisher:
   - organização: `jerasoft-co`;
   - repositório: `jerasoft-brand-cli`;
   - workflow: `publish.yml`;
   - environment: `npm-production`.
7. Configure o pacote para exigir 2FA e impedir publicação por tokens.
8. Crie e envie a tag `v1.0.0`. O workflow validará o mesmo commit e reconhecerá
   que a versão de bootstrap já existe, sem tentar republicá-la.

A versão inicial não terá proveniência OIDC, pois ela antecede a associação do
Trusted Publisher. Essa exceção não se repete.

## Releases seguintes

1. Atualize `version` no `package.json` e o `bun.lock` no mesmo commit.
2. Faça commit diretamente em `main` e mantenha a árvore de trabalho limpa.
3. Confira o plano sem publicar com `bun run release --dry-run`.
4. Execute `bun run release`.

O comando lê a versão do `package.json`, valida o estado de `main`, consulta o
npm e as tags existentes, executa `bun ci` e `bun run check`, envia a `main`
quando ela estiver somente à frente do remoto, cria a tag correspondente e
acompanha o `publish.yml` até a versão aparecer no registry. Releases
interrompidos depois do envio da tag podem executar o mesmo comando novamente
para retomar o acompanhamento.

O workflow valida novamente a correspondência entre tag e versão e publica pelo
Trusted Publisher OIDC no environment `npm-production`.

Nunca reutilize uma versão npm, force uma tag publicada ou adicione `NPM_TOKEN`
ao repositório.
