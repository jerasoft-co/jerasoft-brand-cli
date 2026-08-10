# JeraSoft Brand CLI

CLI público que autentica, resolve, valida e materializa contratos, skills e
ativos privados da plataforma de marca JeraSoft. O pacote contém somente o
protocolo de transporte; o conteúdo protegido permanece no repositório
corporativo canônico.

## Uso

Abra o assistente na raiz de qualquer projeto:

```sh
npx @jerasoft/brand@latest
```

Ou, se você já usa Bun:

```sh
bunx --bun @jerasoft/brand@latest
```

O pacote publicado requer Node.js 22 ou superior quando executado com `npx`.
Bun continua suportado como alternativa de execução e como toolchain de
desenvolvimento do repositório.

O menu usa as setas do teclado e detecta automaticamente se o diretório já
contém um projeto, quais stacks e gerenciadores estão presentes, o estado dos
artefatos abertos para agentes e se a integração JeraSoft já foi inicializada.
Em ambientes sem TTY, o CLI falha sem bloquear o processo e orienta o uso de
`--help`; todos os comandos explícitos continuam disponíveis para scripts e CI.

“Ver todos os comandos” abre um catálogo navegável dentro do próprio menu.
Comandos que dependem da inicialização ou do lock continuam visíveis com a
orientação necessária, mas ficam indisponíveis até o pré-requisito ser atendido.
É possível executar uma opção, consultar a versão ou voltar sem encerrar a CLI.

Inicialize uma única vez na raiz de cada projeto:

```sh
npx @jerasoft/brand@latest init
```

O perfil e os adapters podem ser definidos na própria inicialização:

```sh
npx @jerasoft/brand@latest init \
  --appearance=adaptive \
  --token-adapters=css \
  --token-output=.jerasoft/generated
```

O comando cria:

- `.jerasoft/brand.json`, com a política versionada do projeto;
- `.jerasoft/brand.lock.json`, com a resolução e os digests aprovados;
- o manifesto DTCG e os adapters configurados, por padrão em
  `.jerasoft/generated`;
- um bloco gerenciado em `AGENTS.md`;
- três Agent Skills finas e portáveis em `.agents/skills`.

A integração não detecta nem persiste fornecedores de IA. `AGENTS.md` e
`SKILL.md` são tratados como formatos abertos; trocar a ferramenta ou o modelo
usado no projeto não exige reinicializar a marca.

O bootstrap fixa `@1`, permitindo atualizações patch e minor compatíveis sem
migrar silenciosamente para outro major.

### Projetos e AGENTS.md existentes

O CLI não pressupõe um diretório vazio. Ao detectar arquivos existentes, ele
mostra os sinais encontrados e pede confirmação antes de integrar a marca.

Para `AGENTS.md`, a política é:

- se não existir, cria o arquivo com o bloco JeraSoft;
- se já existir, preserva literalmente o conteúdo e acrescenta um bloco entre
  `<!-- jerasoft-brand:start -->` e `<!-- jerasoft-brand:end -->`;
- se o bloco já existir, atualiza somente o conteúdo entre os marcadores;
- se os marcadores estiverem incompletos, invertidos ou duplicados, interrompe
  antes de escrever qualquer arquivo de configuração.

Executar `init` novamente é idempotente e reconcilia somente os arquivos
gerenciados pelo CLI.

### Aparência e tokens

O schema v3 de `.jerasoft/brand.json` declara `appearance.default` como
`light`, `dark` ou `adaptive`, além de perfis opcionais por experiência. O
manifesto DTCG sempre é materializado quando tokens estão habilitados. Os
adapters opcionais são `css`, `delphi-vcl` e `delphi-fmx`.

Configurações schema v1 e v2 são lidas como `light`. `context` e `audit` não as
reescrevem; `init` e `sync` migram para v3. Arquivos gerenciados só são
atualizados quando ainda correspondem ao digest anterior. Divergência manual
interrompe a operação.

### Contexto para agentes

```sh
npx @jerasoft/brand@1 context --profile=apply --format=markdown
npx @jerasoft/brand@1 context --profile=audit --format=json
npx @jerasoft/brand@1 context --profile=assets --fresh
```

Os perfis retornam o contrato vigente e o procedimento privado correspondente.
O perfil `assets` também lista os IDs aprovados e seus digests.

### Materializar um ativo

O destino precisa ficar dentro de `assetDirectory`, configurado por padrão como
`assets/brand`:

```sh
npx @jerasoft/brand@1 asset resolve \
  logo.jerasoft.symbol.default \
  --copy-to=assets/brand/jerasoft-symbol.svg
```

O CLI não sobrescreve um arquivo divergente e rejeita traversal e links
simbólicos.

### Sincronização, auditoria e migração

```sh
npx @jerasoft/brand@1 sync
npx @jerasoft/brand@1 audit --frozen
npx @jerasoft/brand@1 audit --frozen --offline
npx @jerasoft/brand@1 upgrade --major
```

`context` e `audit` nunca modificam o projeto. `init` e `sync` reconciliam a
configuração, o lock e os tokens; `upgrade` e a resolução de ativo também podem
registrar uma nova resolução.

## Autenticação

A ordem é:

1. `GH_TOKEN`, apenas como override efêmero para CI ou execução headless;
2. token do Device Flow armazenado no cofre seguro do sistema;
3. novo Device Flow interativo da GitHub App `JeraSoft Brand Resolver`.

Tokens de acesso expiram e são renovados pelo refresh token sem client secret.
Nenhum token é salvo no projeto, no cache, no receipt ou no pacote npm.

```sh
npx @jerasoft/brand@1 logout
npx @jerasoft/brand@1 logout --purge-cache
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
bun run dev -- --help
bun run dev
bun run dev:watch -- init --dry-run
bun run test:watch
bun run version:bump
bun run check
```

`version:bump` abre um menu navegável com as próximas versões build, minor e
major. Em scripts e CI, use
`bun run version:bump -- <build|minor|major> [--dry-run]`.

`dev` executa diretamente o TypeScript, sem build nem publicação, usando por
padrão a pasta temporária do sistema em `jerasoft-brand-dev`. O diretório é
persistente entre execuções para permitir testar fluxos como `init`, `context`,
`sync` e `audit` em sequência. Para apontar a CLI a outro projeto de teste fora
deste repositório, use `--dev-root=/caminho/absoluto` ou a variável
`JERASOFT_BRAND_DEV_ROOT`:

```sh
bun run dev -- --dev-root=/tmp/minha-app init --dry-run
```

`dev:watch` reinicia a execução quando o código muda. Antes de qualquer deploy,
`bun run check` continua sendo o gate completo de formatação, lint, tipos,
testes, build e inspeção do tarball.

O tarball é limitado a `README.md`, `package.json` e `dist/cli.js`. Não existem
hooks de instalação, client secrets, chaves privadas ou conteúdo de marca no
pacote público.
