# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por AWS SQS. Continua correto com mensagens duplicadas, fora de ordem e várias instâncias rodando ao mesmo tempo.

- Desenho, garantias, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)
- Todas as decisões com justificativa: [docs/decisions.md](docs/decisions.md)

**Stack:** Bun 1.4 · TypeScript estrito · NestJS 12 · PostgreSQL 17 · MikroORM 7 · AWS SQS via LocalStack · Docker Compose · Prometheus (`prom-client`)

## Pré-requisitos

- [Bun](https://bun.sh) 1.4+
- Docker com Docker Compose

## Setup

```bash
bun install
cp .env.example .env
bun run infra:up        # PostgreSQL + LocalStack (cria as filas FIFO e a DLQ)
bun run migrate:up
bun run start           # http://localhost:3000
```

### Três instâncias com Docker Compose

```bash
docker compose --profile app up -d --build
```

Sobe PostgreSQL, LocalStack, roda as migrations uma vez e inicia 3 réplicas da aplicação em `localhost:3001`, `:3002` e `:3003`. Todas consomem a mesma fila e publicam a mesma outbox.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `start:dev` | sobe a aplicação (com `--watch` no dev) |
| `bun run infra:up` / `infra:down` | sobe / derruba PostgreSQL e LocalStack |
| `bun run migrate:up` / `migrate:down` / `migrate:status` | migrations (`migrate:down -- --all` reverte tudo) |
| `bun run test:unit` | testes de unidade (sem infraestrutura) |
| `bun run test:integration` | integração com PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | concorrência real: 50 requisições paralelas, 3 processos, kill -9 + restart |
| `bun test` | tudo |
| `bun run typecheck` / `lint` / `format` | qualidade |

Os testes de integração e concorrência precisam do `bun run infra:up`. Eles criam um banco próprio (`<POSTGRES_DB>_test`) e filas próprias; não tocam nos dados de desenvolvimento.

## API

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | cria wallet; saldo inicial > 0 gera transação `OPENING` + lançamento no ledger |
| `GET` | `/wallets/:walletId` | saldo e version |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=50` | ledger paginado (cursor opaco e estável) |
| `POST` | `/wallets/:walletId/reconciliation` | compara saldo materializado × ledger |
| `POST` | `/wagering/transactions` | submete transação (header `Idempotency-Key` obrigatório) |
| `GET` | `/wagering/transactions/:transactionId` | consulta pelo id interno |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET` | `/health/live`, `/health/ready` | liveness / readiness (PostgreSQL e SQS) |
| `GET` | `/metrics` | métricas Prometheus |

### Status HTTP

| Situação | Status |
|---|---|
| transação processada | `201` (primeira vez) / `200` (replay, `idempotentReplay: true`) |
| aguardando referência (`PENDING_REFERENCE`) | `202` |
| rejeitada por regra de negócio (`REJECTED` + `failureCode`) | `422` |
| payload inválido | `400` |
| recurso inexistente | `404` |
| conflito de idempotência ou duplicidade | `409` |
| falha transitória de infraestrutura | `503` + `Retry-After` |

Erros têm sempre o formato `{ "error": { "code", "message", "details?" } }`.

### Exemplo

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

### Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "providerId": "provider-a", "externalTransactionId": "transaction-123",
            "idempotencyKey": "provider-a:transaction-123", "...": "mesmos campos do HTTP" }
}
```

Use `MessageGroupId = walletId` para manter a ordem por wallet no broker. A correção não depende disso: quem garante é o banco.

## Estrutura

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, ledger, eventos, inbox/outbox
  application/     use cases e portas (UnitOfWork, repositórios, logger, métricas)
  infrastructure/  MikroORM, migrations, SQS, observabilidade, workers
  interface/http/  controllers NestJS, mapeamento de erros, auth guard
test/
  integration/     PostgreSQL + LocalStack reais
  concurrency/     paralelismo real e múltiplos processos
infra/localstack/  script que cria as filas
docs/decisions.md  decisões D1–D28
```

## Autenticação

Não implementada, por decisão de escopo: não pontua no desafio. O ponto de extensão é o `ProviderAuthGuard`, e o desenho proposto (Keycloak, OIDC client-credentials) está no [ARCHITECTURE.md](ARCHITECTURE.md#autenticação-d19).
