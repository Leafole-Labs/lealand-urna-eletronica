# Protocolo sel-ws/1 — urna real de Lealand (mesário ⇄ urna via servidor local)

Transporte: WebSocket RFC 6455 em `ws://<host>:<porta>/ws` (ou `wss:` sob
HTTPS). Sem Internet: `127.0.0.1` (uma máquina) ou `0.0.0.0` + LAN isolada.
Mensagens: JSON texto, sem fragmentação, sem compressão, ≤ 1 MiB, com
máscara (cliente→servidor, exigida). Quadros binários/ping: ping é
respondido com pong; demais opcodes geram erro de protocolo.

## Envelope

```json
{
  "v": 1,
  "type": "<tipo>",
  "urnaId": "urna-01",
  "sessionId": "sel-... (quando aplicável)",
  "token": "<token> (mensagens autenticadas)",
  "reqId": "<id> (ecoado nas respostas, opcional)",
  "...campos do tipo..."
}
```

- `v` diferente de `1` → `error {codigo: "protocolo"}` (conexão mantida).
- Tipo desconhecido → `error {codigo: "protocolo"}`.
- Controle sem token válido → `error {codigo: "auth"}`.
- Comando fora do estado → `error {codigo: "estado"}` (sem transição).

## Papéis e autenticação

- `hello {role: "urna", urnaId}` → `hello-ok {urnaId, token, sessionId}` +
  `status`. Segunda urna com outro `urnaId` é recusada (`urna-ocupada`).
  O token é retomado via `sessionStorage` após reload.
- `hello {role: "mesario" [, token]}` → com token válido, retoma
  (`hello-ok {retomada: true}`); sem token, `hello-ok
  {pareamentoNecessario: true}`.
- `pair {code}` (só mesário, só sem terminal ativo): código de 6 dígitos,
  5 minutos, uso único → `paired {token}`. Segundo terminal é recusado.
- `register_mesario {nome, matricula}` (fictícios, ≥3 caracteres) →
  `registered`. Registrado no log da sessão.

## Ciclo eleitoral (máquina de estados do servidor)

```text
BOOT → SELF_TEST → KEYBOARD_TEST → PREPARING → WAITING_FOR_POLL_WORKER
  → READY → VOTER_AUTHORIZED → VOTING → VOTE_FINISHED → READY … →
  CLOSING → CLOSED
```

| Mensagem | Origem | Pré-condição | Efeito |
|---|---|---|---|
| `self_test_result {checks[]}` | urna | BOOT/SELF_TEST | valida `wasm-sha256`, `dataset-manifest`, `dataset-size` → KEYBOARD_TEST |
| `key_test_complete {keys[]}` | urna | KEYBOARD_TEST | exige as 13 teclas → PREPARING → WAITING + código de pareamento |
| `authorize_voter {}` | mesário | READY | `VOTER_AUTHORIZED {eleitorSeq}` (sequencial) |
| `voting_started {}` | urna | VOTER_AUTHORIZED | VOTING (mesário vê ELEITOR VOTANDO) |
| `vote_cast {clientVoteId, vote:{tipo, numero}}` | urna | VOTING | valida e persiste → `vote-ack {clientVoteId, seq}` (idempotente) |
| `vote_finished {}` | urna | VOTING | VOTE_FINISHED → urna recarrega e envia `voter_ready` |
| `voter_ready {}` | urna | VOTE_FINISHED | READY |
| `sync_push {votes[]}` | urna | qualquer | mescla por `clientVoteId` → `sync-ack {acks, novos, total}` |
| `close_session {}` | mesário | READY | CLOSING → artefatos → CLOSED + `session_closed {zipUrl}` |

Transições fora dessa tabela são recusadas (ex.: autorizar durante VOTING,
encerrar fora de READY).

## Sigilo do voto (§15)

- `vote_cast`/`sync_push` só são aceitos do papel `urna`; do mesário, erro.
- O servidor **nunca** envia conteúdo de voto ao mesário: `status` leva só
  `{state, sessionId, eleitorSeq, votosCount, mesario, urnaConectada}` e
  eventos marcados `publico`. Eventos de voto são `sigiloso` (só no arquivo).
- Queda durante VOTING: a urna mantém o estado local, enfileira em outbox e
  reenvia via `sync_push` ao reconectar (deduplicação por `clientVoteId`);
  a reconexão não altera o voto; o terminal só vê ELEITOR VOTANDO e depois
  VOTO CONCLUÍDO (contagem, sem conteúdo).

## Integridade e resultados

Encerramento gera (mesma implementação validada do portal):
`t02400ll0000100010001-{bu.json, rdv.json, log.zip, bu.txt, vota.json,
candidaturas.json}` — cadeia SHA-512 com a matemática do `verify.js` do
urnaemu, assinatura ECDSA P-521 (`SEL-TESTE-P521`), fase 2 (motor em fase
oficial). Download em `GET /api/zip?token=<token-do-mesario>` (401 sem
token, 409 antes de CLOSED). O ZIP é aceito pela apuração existente sem
alterações.
