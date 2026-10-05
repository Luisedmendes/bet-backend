# Decisões técnicas

Registro curto das decisões tomadas durante o desenvolvimento. Serve de base para o `ARCHITECTURE.md`.

## Arquitetura

### D1. Pastas organizadas por camada
`src/domain`, `src/application`, `src/infrastructure`, `src/interface`.

O sistema é um contexto só: wallet e transação de aposta sempre andam juntas na mesma transação SQL. Separar por módulo de negócio só criaria dependências cruzadas.

### D2. Domínio separado da persistência, com mapper
Classes de domínio puras (`Wallet`, `Money`...) e entidades do MikroORM só para mapear tabelas. Um mapper converte uma na outra.

O README exige que o domínio não dependa do ORM e que a leitura do banco passe pela factory `rehydrate`. Mapear a classe de domínio direto no ORM faria o próprio ORM montar o objeto, sem passar pelo `rehydrate`.

### D3. Use case não conhece a porta de entrada
O use case recebe um objeto simples e devolve um resultado simples. HTTP e SQS só traduzem a entrada e a saída.

O README exige que HTTP e SQS usem o mesmo use case. Começamos pelo HTTP; a fila entra depois sem mexer na regra de negócio.

## Money

### D4. Valor interno em `bigint` de centavos
`"25.00"` vira `2500n`.

A escala é fixa em 2 casas e só há soma, subtração e comparação, então inteiros em centavos são exatos e dispensam biblioteca. Se um dia precisar de escala variável, a troca fica restrita à classe `Money`.

### D5. Formato de entrada estrito: exatamente 2 casas
Regex: `^(0|[1-9]\d*)\.\d{2}$`. Rejeita `"25"`, `"25.5"`, `"25.000"`, `"+25.00"`, `" 25.00"`, `"007.00"`, notação científica, `NaN`, `Infinity` e string vazia.

É a leitura literal de "sempre com escala fixa de 2 casas". Uma única forma de escrever cada valor evita ambiguidade no contrato e no hash de idempotência. Nunca há arredondamento: valor fora do formato é rejeitado.

### D6. `Money` pode ser negativo, mas a entrada não
`Money.from()` rejeita negativos. Negativos só surgem de operações (`subtract`, `negate`).

A interface do README tem `negate()` e `isNegative()`, e a `difference` da reconciliação pode ser negativa. A regra "saldo nunca negativo" é da `Wallet` e do banco, não do `Money`.

### D7. Moeda validada só pelo formato ISO-4217
Três letras maiúsculas: `^[A-Z]{3}$`.

O `Money` é genérico. Quais moedas o negócio aceita é outra regra. O formato basta para testar conflito entre `BRL` e `USD`.

## Wallet

### D8. `debit()` e `credit()` devolvem o lançamento do ledger
A própria `Wallet` cria o `WalletLedgerEntry` no momento em que muda o saldo.

O README exige que toda alteração de saldo tenha lançamento. Gerando os dois juntos, não existe caminho que mude o saldo sem lançamento: a regra fica na estrutura, não na disciplina de quem chama.

### D9. Saldo insuficiente lança `InsufficientFundsError`
O use case captura e marca a transação como `REJECTED`, escolhendo o `failureCode` pelo tipo (aposta ou reversão).

Mesmo padrão do `Money`. A `Wallet` se protege sozinha, mesmo que quem chama esqueça de checar. Quem distingue "aposta sem saldo" de "reversão sem saldo" é o use case, que sabe o tipo da operação.

### D10. Débito e crédito só aceitam valores positivos
Zero ou negativo lança erro.

Movimentação de zero não muda o saldo, então não deveria subir a `version` nem gerar lançamento. Aceitar complicaria as duas regras. Uma `BET` de `0.00` é rejeitada na transação; `LOSS` nem chama a `Wallet`.

## Ledger

### D11. `money` do lançamento sempre positivo; o sentido vem da `direction`
Um débito de 80 é `{ direction: DEBIT, money: "80.00" }`.

Com sinal, `direction` e sinal diriam a mesma coisa e poderiam se contradizer. Assim há uma fonte só, e o banco garante `amount > 0` com `CHECK`.

### D12. Ids gerados no domínio, em UUID v7
Função `newId()` em `domain/shared`, usando `Bun.randomUUIDv7()`.

O valor do id não carrega regra de negócio, então não precisa vir de fora. O v7 começa com o horário: inserts vão para o fim do índice e a paginação do ledger por cursor segue a ordem de criação.

### D13. Datas passadas por parâmetro (`at`), nunca `new Date()` no domínio
Ex.: `wallet.debit(money, transactionId, at)`.

Os testes conseguem verificar as datas, e o use case usa o mesmo instante para transação, lançamento e evento. É o padrão do próprio README (`markProcessed(..., at)`, `isDue(now)`).

## Decisões tomadas na reta final (implementação)

### D14. Concorrência: lock pessimista por wallet
`SELECT … FOR UPDATE` na linha da wallet, dentro da transação, antes de qualquer leitura de idempotência ou regra. `SET LOCAL lock_timeout` (5s) transforma espera longa em erro transitório (503 / retry na fila).

Serializa tudo o que toca a mesma wallet em todas as instâncias, sem lock global. Resolve o cenário 100 − 80 − 80 de forma determinística. O `version` continua existindo e um trigger exige `+1` exatamente quando o saldo muda. Lock otimista exigiria retry em toda colisão, e a hot wallet colide o tempo todo.

### D15. Idempotência no banco
`UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. A verificação acontece depois do lock da wallet. Se duas requisições com a mesma key correm em wallets diferentes, o banco barra o segundo INSERT, o use case repete e cai no replay ou no conflito. O replay devolve o resultado gravado (`result_balance`), nunca o saldo atual.

### D16. Uma transação só pode ser revertida uma vez, por qualquer tipo de reversão
Índice único parcial em `reference_transaction_id` para REFUND/ROLLBACK `PROCESSED`.

O README pede "não reverter duas vezes pelo mesmo tipo". Interpretamos de forma mais estrita: um REFUND seguido de um ROLLBACK da mesma BET creditaria duas vezes. Reverter a reversão (ROLLBACK de um REFUND) continua permitido, porque a referência é outra.

### D17. Regras do §7 numa função de domínio pura
`settleWagerTransaction` recebe transação, wallet, referência e "já revertida?" e decide. Não conhece banco nem HTTP: é testada só com objetos. O use case carrega, trava, chama a função e grava.

### D18. Mapeamento HTTP
| Situação | Status |
|---|---|
| PROCESSED (primeira vez) | 201 |
| PROCESSED (replay) | 200 |
| PENDING_REFERENCE | 202 |
| REJECTED (regra de negócio, com `failureCode`) | 422 |
| payload inválido | 400 |
| wallet/transação inexistente | 404 |
| conflito de idempotência / duplicidade | 409 |
| falha transitória (banco fora, lock timeout) | 503 + `Retry-After` |

Corpo de erro sempre `{ error: { code, message, details? } }`.

### D19. Autenticação não implementada
`ProviderAuthGuard` no-op nos endpoints de negócio; health e metrics ficam abertos. Desenho: OIDC client-credentials num Keycloak, um client por provedor, guard valida o JWT por JWKS e exige `body.providerId` igual ao do token.

### D20. Classificação de falhas na fila
- **ack**: transação decidida e commitada (PROCESSED, REJECTED, PENDING_REFERENCE) ou replay.
- **retry**: erro transitório ou inesperado → `ChangeMessageVisibility` com backoff (2s, 4s, 8s… até 60s). Após `maxReceiveCount` (5) o redrive do SQS leva à DLQ.
- **DLQ direto**: payload inválido, conflito de idempotência, wallet inexistente: nunca vão dar certo como estão.

### D21. Outbox com `FOR UPDATE SKIP LOCKED`
O publisher trava um lote, publica e marca `published_at` na mesma transação. Publishers concorrentes pegam lotes diferentes. Se morrer entre publicar e commitar, o lote volta e é republicado: at-least-once. `MessageDeduplicationId = eventId` (o SQS descarta em 5 min) e o consumidor deduplica por `eventId`. `MessageGroupId = walletId`.

### D22. Referências fora de ordem
10 tentativas com backoff 1s, 2s, 4s… até 5 min (≈13 min no total), depois `REJECTED / REFERENCE_NOT_FOUND`. Quando a referência chega, as transações que esperavam por ela são antecipadas (`next_reference_attempt_at = now`). O evento `WagerTransactionPendingReference` sai só na primeira vez.

### D23. Garantias no schema
CHECKs de sinal, formato e coerência de status; UNIQUEs de idempotência e de wallet; ledger append-only (triggers bloqueiam UPDATE/DELETE/TRUNCATE); ledger encadeado (`balance_before` = `balance_after` anterior); transação terminal imutável; constraint trigger DEFERRED que no COMMIT exige `wallet.balance` = último `balance_after`.

### D24. MikroORM
Decorators legacy (escolha anterior). Unit of Work explícita: um `fork()` por operação, `flushMode: COMMIT` (tudo vai ao banco no fim, junto) e FKs `DEFERRABLE INITIALLY DEFERRED`, então a ordem dos INSERTs no flush não importa. Leituras do ledger e o INSERT da inbox (`ON CONFLICT DO NOTHING`) usam SQL explícito.

### D25. Valores zero e LOSS
LOSS pode vir com `0.00` (não move saldo). BET/WIN/REFUND/ROLLBACK com `0.00` são REJECTED com `INVALID_AMOUNT`.

### D26. WIN e LOSS podem referenciar a BET
Opcional. Se vier, precisa resolver (BET da mesma rodada, player, wallet e moeda); se ainda não existe, a transação espera como PENDING_REFERENCE.

### D27. Wallet inexistente não é persistida
Sem wallet não há onde registrar a transação (FK). HTTP 404; fila → DLQ.

### D28. Hash do payload
`payloadHash = SHA-256 hex` do JSON canônico (chaves ordenadas recursivamente, `undefined` omitido) de `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`. A `Idempotency-Key`, o `messageId` e o `occurredAt` ficam de fora.
