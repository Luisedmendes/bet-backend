# Arquitetura

Serviço que processa transações de apostas (`BET → WIN | LOSS | REFUND | ROLLBACK`) vindas de provedores por HTTP e por SQS, mantendo saldo e ledger corretos com mensagens duplicadas, fora de ordem e processadas por várias instâncias ao mesmo tempo.

A lista completa de decisões, com a justificativa de cada uma, está em [docs/decisions.md](docs/decisions.md) (D1–D28). Este documento junta o desenho.

## Visão geral

```
 HTTP  POST /wagering/transactions ─┐
                                    ├─► ProcessWagerTransactionUseCase ──► UMA transação SQL:
 SQS   wager-transactions.fifo ─────┘    (mesmo use case, README §10)        1. inbox (se SQS)
                                                                             2. SELECT wallet FOR UPDATE
                                                                             3. idempotência (key + hash)
                                                                             4. regras do domínio
                                                                             5. transação + ledger + saldo
                                                                             6. eventos na outbox
                                                                           COMMIT
 Workers (em todas as instâncias):
   - publisher da outbox   (FOR UPDATE SKIP LOCKED → wagering-events.fifo)
   - referências pendentes (lock da wallet, backoff exponencial)
```

### Camadas (D1, D2, D3)

| Pasta | Conteúdo | Depende de |
|---|---|---|
| `src/domain` | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `settleWagerTransaction` | nada (TypeScript puro) |
| `src/application` | use cases, portas (`UnitOfWork`, repositórios, logger, métricas), validação de entrada, hash | domínio |
| `src/infrastructure` | MikroORM (entidades, mappers, repositórios, migrations), SQS, logger JSON, Prometheus, workers | aplicação |
| `src/interface/http` | controllers NestJS, filtro de erros, guard de auth, correlação | aplicação |

O domínio não importa NestJS nem MikroORM. Toda leitura do banco passa pelo `rehydrate` das classes de domínio (via mappers). A composição (qual implementação atende cada porta) fica só no `AppModule`.

## Dinheiro (D4–D7)

`Money` guarda `bigint` em centavos. Entrada e saída são strings com exatamente 2 casas (`^(0|[1-9]\d*)\.\d{2}$`); notação científica, `NaN`, `Infinity`, sinal, espaços, zeros à esquerda e casa decimal extra são rejeitados, e nunca há arredondamento. No banco: `numeric(19,2)` + `char(3)`, lidos como string e reidratados com `Money.from`. Nenhum `number` toca em valores monetários.

## Concorrência (D14)

A unidade de concorrência é a `walletId`. Toda operação que altera uma wallet faz `SELECT … FOR UPDATE` nela antes de qualquer decisão: idempotência, referência e saldo são lidos já com o lock. Wallets diferentes não se bloqueiam. Não há lock global.

- **Cenário obrigatório** (100.00, duas BETs de 80.00 em paralelo): a segunda espera o lock, enxerga 20.00 e é REJECTED com `INSUFFICIENT_FUNDS`. O teste roda 5 vezes seguidas.
- **Hot wallet**: `lock_timeout` de 5s; estourar vira erro transitório (503 / retry na fila), contado em `wagering_lock_conflicts_total`.
- **Defesa em profundidade**: mesmo com um bug no código, o banco recusa saldo negativo (CHECK), salto de version (trigger) e saldo diferente do ledger (constraint trigger no COMMIT).

## Idempotência (D15, D28)

- `Idempotency-Key` é a fonte da verdade, com `UNIQUE` no banco.
- `payloadHash` é o SHA-256 do JSON canônico dos campos de negócio.
- Mesma key e mesmo hash → replay: devolve o resultado gravado (status, `failureCode`, saldo observado na época) com `idempotentReplay: true`.
- Mesma key e hash diferente → `409 IDEMPOTENCY_CONFLICT`.
- Mesmo `(providerId, externalTransactionId)` com outra key → `409 EXTERNAL_TRANSACTION_CONFLICT`.
- Corrida da mesma key em wallets diferentes: o `UNIQUE` barra o segundo INSERT, o use case repete (até 3x) e cai no replay ou no conflito.
- Na fila, a inbox `(consumer_name, message_id)` é gravada na mesma transação. Redelivery da mesma mensagem é descartado; mesma operação com outro `messageId` cai no replay.

## Ledger e reconciliação (D8, D11, D23)

- `debit()`/`credit()` da `Wallet` devolvem o `WalletLedgerEntry`: não existe caminho que mude o saldo sem lançamento.
- O lançamento guarda `balanceBefore`, `money` (sempre positivo, sentido pela `direction`) e `balanceAfter`; a factory e um CHECK validam a conta.
- O banco é append-only (triggers bloqueiam UPDATE/DELETE/TRUNCATE) e encadeado (cada `balance_before` = `balance_after` anterior).
- `POST /wallets/:id/reconciliation` lê a wallet com `FOR SHARE`, soma créditos e débitos e compara. Divergência é logada (`error`), contada em `wagering_reconciliation_divergences_total` e devolvida com `consistent: false`. Nunca é corrigida automaticamente.

## Regras de negócio (D16, D17, D25, D26)

| Operação | Saldo | Ledger | Regra |
|---|---|---|---|
| `BET` | débito | 1 DEBIT | sem saldo → `INSUFFICIENT_FUNDS` |
| `WIN` | crédito | 1 CREDIT | referência à BET opcional |
| `LOSS` | — | — | registra o resultado; aceita `0.00` |
| `REFUND` | crédito | 1 CREDIT | só referencia BET; mesmo valor; uma vez |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | referencia BET, WIN ou REFUND; sem saldo → `REVERSAL_INSUFFICIENT_FUNDS` |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ser do mesmo player, wallet, moeda e rodada. Cada transação só pode ser revertida uma vez, por qualquer tipo de reversão (D16).

### Estados da transação

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa)
PROCESSED, REJECTED, FAILED: terminais (o domínio lança erro e o banco recusa UPDATE)
```

`FAILED` só é usado pelo worker de referências, quando uma reavaliação falha com erro permanente inesperado: a transação fica terminal e auditável em vez de ser tentada para sempre.

### Códigos de falha

| `failureCode` | Quando | O provedor deve… |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | desistir ou reenviar depois que o saldo mudar (nova operação) |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de crédito sem saldo | acionar operação; não é erro do jogador |
| `INVALID_AMOUNT` | valor zero em operação que movimenta saldo | corrigir o payload |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | player não é dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | referência não chegou no prazo | investigar a referência |
| `REFERENCE_INVALID_KIND` | ex.: REFUND de um WIN | corrigir o payload |
| `REFERENCE_MISMATCH` | outra rodada/player/wallet/moeda | corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | reversão com valor diferente | corrigir (reversão parcial fora de escopo) |
| `REFERENCE_NOT_PROCESSED` | referência foi REJECTED/FAILED | desistir |
| `ALREADY_REVERSED` | referência já revertida | nada: o efeito já existe |
| `PROCESSING_ERROR` | `FAILED` no reprocessamento | acionar operação |

## Referências fora de ordem (D22)

Sem referência, a transação é gravada como `PENDING_REFERENCE` (HTTP 202) com `next_reference_attempt_at`. O worker (em todas as instâncias) busca as vencidas, trava a wallet, relê a transação e reavalia. São 10 tentativas com backoff exponencial de 1s até 5 min (≈13 min); esgotado o limite, a transação vira `REJECTED / REFERENCE_NOT_FOUND` e o evento `WagerTransactionRejected` é publicado. Quando a referência chega, as dependentes são antecipadas para a próxima rodada do worker.

## Mensageria (D20, D21)

**Consumidor** (`wager-transactions.fifo`): long polling; mensagens do mesmo `MessageGroupId` em sequência, grupos diferentes em paralelo. O `DeleteMessage` (ack) só acontece depois do commit.

| Resultado | Ação |
|---|---|
| PROCESSED / REJECTED / PENDING_REFERENCE / replay | ack |
| erro transitório ou inesperado | `ChangeMessageVisibility` com backoff; após 5 recebimentos o redrive manda à DLQ |
| JSON inválido, payload inválido, conflito, wallet inexistente | envia à `wager-transactions-dlq.fifo` com o motivo e faz ack |

No **SIGTERM**, o consumidor para de buscar, espera as mensagens em andamento até `SHUTDOWN_DRAIN_MS` e devolve as restantes à fila (`VisibilityTimeout=0`); só então o banco é fechado.

**Outbox**: os eventos são gravados em `outbox_messages` na mesma transação do efeito. O publisher trava um lote com `FOR UPDATE SKIP LOCKED`, publica em `wagering-events.fifo` (`MessageGroupId = walletId`, `MessageDeduplicationId = eventId`) e marca `published_at` no mesmo commit. Se a publicação falha, `scheduleRetry` aplica backoff exponencial; se o processo morre entre publicar e commitar, o lote volta a ficar disponível e é republicado.

Eventos: `WagerTransactionProcessed` (inclusive LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (só quando o saldo muda, com `walletVersion`) e `WagerTransactionPendingReference`. O envelope é uma classe abstrata (`IntegrationEvent`), com `eventType` e `version` fixos em cada subclasse; `data` só contém JSON estável (`MoneyProps`).

## Persistência (D23, D24)

PostgreSQL 17 + MikroORM 7 (preferencial no README). Unit of Work explícita: cada operação é um `em.fork()` + `em.transactional()`, com `flushMode: COMMIT`. As entidades do ORM são só o formato das linhas; o schema vem de migrations escritas à mão, versionadas e reversíveis (o teste roda up → down → up).

| Tabela | Garantias no banco |
|---|---|
| `wallets` | `UNIQUE(player_id, currency)`, `balance >= 0`, version 1 na criação e `+1` só com mudança de saldo, sem DELETE |
| `wager_transactions` | `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, referência obrigatória para REFUND/ROLLBACK, reversão única (índice parcial), coerência status × `failure_code` × `processed_at`, terminal imutável, sem DELETE |
| `wallet_ledger_entries` | append-only, aritmética do lançamento, cadeia de saldos, `UNIQUE(wallet_id, transaction_id)`, `amount > 0` |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | evento imutável, publicado não volta a pendente |

Uma constraint trigger `DEFERRABLE INITIALLY DEFERRED` verifica no COMMIT que `wallets.balance` = último `balance_after` do ledger. Isso garante "toda alteração de saldo tem lançamento, e vice-versa" mesmo contra SQL escrito à mão.

## Observabilidade

- **Logs** em JSON (uma linha por evento) com `instanceId`, `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, propagados por `AsyncLocalStorage`. Valores e saldos não entram nos logs.
- **Métricas** em `GET /metrics` (Prometheus): `wagering_transactions_total{status,kind,source}`, `wagering_duplicates_total{kind}`, `wagering_retries_total{component}`, `wagering_dlq_messages_total{reason}`, `wagering_lock_conflicts_total{reason}`, `wagering_outbox_pending`, `wagering_outbox_lag_seconds`, `wagering_processing_duration_seconds` e `wagering_reconciliation_divergences_total`.
- **Health**: `GET /health/live` (processo) e `GET /health/ready` (PostgreSQL e SQS, com timeout de 2s), ambos sem autenticação.
- **Correlação**: `X-Correlation-Id` é aceito ou gerado, devolvido na resposta e gravado no envelope dos eventos.

## Autenticação (D19)

Não implementada, por decisão de timebox: autenticação não pontua (README §2). O ponto de extensão é o `ProviderAuthGuard` (`src/interface/http/auth.guard.ts`), aplicado aos controllers de negócio e não aos de health. O desenho seria OIDC client-credentials num Keycloak no compose: um client por provedor, guard validando o JWT por JWKS (issuer, audience, expiração) e exigindo `body.providerId === token.providerId`. Mensagens da fila são canal interno confiável, mas `providerId`, player e wallet continuam validados pelo domínio.

## Testes

| Suíte | O que cobre |
|---|---|
| `bun run test:unit` | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, hash e payload divergente |
| `bun run test:integration` | constraints e triggers do schema, migrations reversíveis, fluxos HTTP, atomicidade, referências fora de ordem, inbox e redelivery, crash depois do commit e antes do ack, retry e DLQ, SIGTERM, publishers concorrentes, crash do publisher antes do commit |
| `bun run test:concurrency` | mesma BET 50x em paralelo, 100 − 80 − 80 (5 rodadas), hot wallet com 40 BETs, wallets em paralelo, **3 processos** reais disputando HTTP e SQS, **kill -9 no meio do tráfego** com restart e verificação final |

Todos usam PostgreSQL e LocalStack reais; nada é substituído por mock. Toda suíte termina verificando `wallet.balance == saldo reconstruído pelo ledger`.

## Trade-offs e limitações

- **Lock pessimista na hot wallet**: o throughput de uma única wallet é limitado pela duração da transação. É a escolha certa para dinheiro (sem retries em cascata), mas uma wallet extremamente quente enfileira. Mitigação possível: transações curtas (já são), `lock_timeout` e particionar o tráfego por wallet no broker.
- **Publisher segura a transação durante o envio ao SQS**: simplifica o "publica e marca" atômico, ao custo de manter linhas travadas por alguns milissegundos. Com SKIP LOCKED isso não bloqueia outros publishers.
- **Ordem dos eventos**: com vários publishers, dois eventos da mesma wallet podem sair fora de ordem. Os eventos carregam `walletVersion` e `occurredAt` para o consumidor ordenar e descartar duplicatas.
- **Inbox e outbox crescem sem limpeza**: em produção, um job apagaria inbox antiga (além da janela de redelivery) e outbox já publicada.
- **Referências**: o limite de ≈13 min é configurável (`REFERENCE_MAX_ATTEMPTS`, `REFERENCE_BASE_DELAY_MS`) e não foi calibrado com dados reais de provedores.
- **Moeda**: o modelo é multi-moeda e os conflitos são testados, mas não há câmbio; cada wallet tem uma moeda.
- **Sem teste de carga** (diferencial opcional não feito).
- **LocalStack fixado na 4.4**: as imagens mais novas exigem token de autenticação.
