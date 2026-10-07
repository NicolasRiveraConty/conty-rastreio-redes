# Sync de métricas de criadores

Serviço que recebe uma conexão já autorizada (token fictício) e grava um snapshot das métricas dos posts. O mesmo snapshot não soma de novo. Timeout e 429 tentam outra vez, com teto.

## Como rodar

Requer Node 20+.

```bash
npm install
npm test
npm start
```

A API sobe em `http://localhost:3000`.

```bash
curl -s -X POST localhost:3000/connections \
  -H 'content-type: application/json' \
  -d '{"platform":"instagram","creatorId":"criador-1","accessToken":"token-ficticio"}'

curl -s -X POST localhost:3000/sync \
  -H 'content-type: application/json' \
  -d '{"connectionId":"ID","windowStart":"2026-10-01T00:00:00.000Z","windowEnd":"2026-10-08T00:00:00.000Z"}'

curl -s "localhost:3000/metrics?connectionId=ID"
```

`PROVIDER_SCENARIO` troca o roteiro do provedor fake deste processo. Os testes não usam essa variável: cada um monta o próprio fake.

| valor | comportamento |
| --- | --- |
| `ok` (padrão) | devolve os posts uma vez |
| `duplicate` | manda cada post duas vezes no mesmo corpo |
| `rate_limit` | 429 com `Retry-After` de 200ms, depois sucesso |
| `timeout` | um timeout, depois sucesso |
| `timeout_exhausted` | timeout em toda chamada; o sync para em `maxAttempts` e a API responde 503 |

`npm run typecheck` confere os tipos.

## Por onde começar

1. `src/provider/metrics-provider.ts` — o que o provedor pode fazer, e o que ele não decide
2. `src/provider/fake-metrics-provider.ts` — timeout, duplicata e 429
3. `src/sync/retry.ts` — backoff, `Retry-After` e o teto de tentativas
4. `src/sync/sync-service.ts` — chave do snapshot, `fetchedAt`, e a regra de não somar
5. `tests/sync-service.test.ts` — os casos do enunciado

## Arquitetura

```
HTTP (Fastify)
  └─ SyncService                 regra de negócio
       ├─ MetricsProvider        interface; o fake só simula a rede
       └─ MetricsRepository
            └─ memória
```

O provedor devolve posts ou lança `ProviderRequestError` (`timeout`, `rate_limited`, `unavailable`, `unauthorized`). Ele não grava, não escolhe quantas vezes tentar e não marca `fetchedAt`.

O `SyncService` tenta de novo, monta a chave `(provedor, post, janela)` e persiste. O HTTP valida o corpo, chama o serviço e traduz falha esgotada em 503.

Um cliente de Instagram, TikTok, YouTube ou X entra como outro `MetricsProvider`. A regra permanece a mesma.

## Idempotência

Chave: `provedor|id do post|início da janela|fim da janela`. As datas são normalizadas para UTC, então `2026-10-01T00:00:00Z` e `2026-10-01T00:00:00.000Z` são a mesma janela.

- O primeiro fetch daquela chave grava views, likes, comments, shares e `fetchedAt`.
- O mesmo post de novo, na mesma janela, devolve o registro existente (`outcome: "replayed"`). O número guardado não muda e não é somado, mesmo que o provedor mande um valor maior.
- Se o mesmo post vem duas vezes na mesma resposta, vale a primeira ocorrência. As cópias seguintes entram em `droppedAsDuplicateInResponse` e ficam fora da soma.
- Outra janela é outro snapshot. Os dois coexistem.

`fetchedAt` é o relógio do serviço no momento em que a resposta do provedor foi aceita, já depois dos retries. Num replay, continua o instante original.

## 429 e timeout

Os dois são falhas transitórias. Cada chamada consome uma tentativa. O laço vai até `maxAttempts` (padrão 4, contando a primeira) e para. Não há retry recursivo.

- **429**: se o erro traz `retryAfterMs` (o `Retry-After` do provedor), a espera é esse valor, mesmo acima do teto do backoff. Sem `Retry-After`, vale o backoff exponencial.
- **Timeout** e indisponibilidade: espera `baseDelayMs * 2^(tentativa-1)`, limitada por `maxDelayMs`. No processo HTTP o padrão é 200ms, 400ms, 800ms, com teto de 2000ms.
- **Token recusado**: não tenta de novo.

Se as tentativas acabam, nada é gravado. A API responde 503 com `attempts`, `waitedMs` e `error.code`. Nos testes o relógio é manual: o tempo avança na hora, sem `sleep` real.

## O que ficou de fora

- OAuth e refresh de token
- Chamada real aos provedores
- Fila, cron e mais de um processo
- Banco durável (a interface do repositório é o lugar para encaixar SQLite ou Postgres)
- Corrigir um snapshot já gravado; a primeira leitura da janela permanece

## Uso de IA

O código deste repositório foi gerado por um agente de IA (Cursor).

Revisado por Nicolas: [preencher]
