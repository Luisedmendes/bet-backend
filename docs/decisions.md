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
