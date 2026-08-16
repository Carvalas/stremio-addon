# Live TV — addon estático de TV ao vivo (sem servidor próprio)

Addon de TV ao vivo que consome diretamente as APIs públicas de um app de TV
e entrega streams HLS que funcionam **sem headers especiais**. Este
projeto **não** mantém servidor próprio, **não** tem proxy HLS próprio, **não**
exige VPS/Docker — ele gera um addon **estático** publicado em GitHub Pages,
renovado diariamente.

---

## 1. O que é

- Catálogos de canais (Abertos, Esportes, Notícias, Infantil, Variedades,
  Documentários, Filmes & Séries, 24 Horas, Eventos + Todos).
- Meta de cada canal com logo e "no ar agora" (EPG XMLTV).
- Streams **somente diretos**: cada fonte é classificada por um probe HTTP e só
  é entregue se for uma playlist HLS reproduzível.
- Busca por nome no catálogo "Todos".
- Duas formas de usar: **addon para clientes Stremio-compatíveis** (protocolo
  Stremio) e **lista M3U** para players que consomem esse formato.

## 2. Limitação real do protocolo (importante)

Um addon do protocolo Stremio **precisa ser servido por HTTP/HTTPS** (ou IPFS).
Não existe instalação por arquivo local. Portanto:

> "Não é possível cumprir o requisito de zero servidor com um addon tradicional
> para **outros dispositivos**."

Na prática, há dois modos de uso:

```
PC (mesma máquina do cliente)  →  Node.js local  →  cliente Stremio-compatível
```

Você roda `npm start`, instala `http://localhost:7000/manifest.json` e o addon
funciona sem nenhuma hospedagem/VPS/domínio, enquanto o processo estiver no ar.
Para **outros dispositivos / sem o PC ligado**, existe o addon **estático** em
GitHub Pages (ver seção 8b — Opção B): o workflow gera manifest + catálogos +
streams com links crus e publica tudo em gh-pages, renovando os links diariamente.

## 3. Requisitos

- Node.js ≥ 18 (testado com Node 24).
- Um cliente Stremio-compatível no mesmo computador (para o modo local).

## 4. Instalação

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:7000`.

## 5. Configuração

Variáveis de ambiente (todas opcionais):

| Variável | Default | Efeito |
| --- | --- | --- |
| `PORT` | `7000` | Porta HTTP |
| `HOST` | `0.0.0.0` | Interface de rede |
| `API_BASE_URL` | *(base da API)* | Base da API |
| `EPG_BASE_URL` | *(fonte do XMLTV)* | Fonte do EPG |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `CHANNELS_TTL_MS` | `600000` | Cache de canais (10 min) |
| `EPG_TTL_MS` | `21600000` | Cache do EPG (6 h) |
| `PROBE_TTL_MS` | `600000` | Cache do resultado dos probes (10 min) |
| `PLAYER_UA` | `DVPlayer/35 (Android 9)` | UA usado nos probes |

## 6. Endpoints

- `/health` — status do servidor.
- `/manifest.json` — manifest do addon.
- `/catalog/channel/<catálogo>.json` — catálogos (ex.: `maxnet-todos`).
- `/catalog/channel/maxnet-todos/search=<q>.json` — busca.
- `/meta/channel/<id>.json` — detalhes + programa atual.
- `/stream/channel/<id>.json` — streams (links crus).
- `/epg.xml` — XMLTV cru para players externos.
- `/playlist.m3u` — lista M3U dos canais reproduzíveis (players M3U).

## 7. Catálogo somente com canais reproduzíveis

Por padrão, o addon exibe **apenas os canais que têm stream direto confirmado**.
A lista é gravada pelo script de análise em

```
out/compatible-channels.json
```

- Para atualizar: rode `npm run analyze-streams` (regrava o arquivo com o que
  estiver no ar naquele momento; alguns canais saem/entram).
- `meta` e `stream` continuam respondendo para qualquer id — se o cliente
  tiver canais antigos em cache, eles ainda resolvem (e o stream segue
  honesto: só aparece se o probe confirmar).

## 8. Gate de fontes (o que entra no addon)

O addon estático entrega **somente** streams que tocam crus (sem headers):

| Fonte | Entra? |
| --- | --- |
| Host confirmado por probe de playlist **sem headers** (`HEADER_WORKING`) | ✅ link cru da própria fonte |
| Host confirmado `DIRECT_WORKING` e link não classificado como ruim | ✅ link cru |
| Link ruim (playlist abre mas segmento falha, protegido, timeout, host morto, desconhecido) | ❌ fora |

- O gate é **por host** para fontes sem headers: links podem rotacionar por
  sessão, mas o host é fixo — se o host foi confirmado, as fontes dele entram.
- Links conhecidamente ruins (por ex.: playlist 403/404, segmento 4xx,
  protegido, timeout, host morto) ficam **fora mesmo em host confirmado**.
- A lista de hosts confirmados e de links ruins é gravada em
  `out/header-working-sources.json` e `out/direct-working-sources.json`
  (regravadas por `npm run analyze-streams`).

Fluxo do stream:

```
DIRECT  →  cliente → URL original (link cru, sem proxy)
```

## 9. Classificação e análise das fontes

Cada fonte é classificada pelas regras da API e por **probe HTTP real sem
headers** (UA de player, sem Referer):

| Classe | Significado |
| --- | --- |
| `DIRECT` | Playlist HLS confirmada sem headers → entregue ao addon |
| `DIRECT_WITH_HEADERS` | Exige Referer/UA/Origin → **não** entregue |
| `GETLINK` | Resolve via endpoint intermediário; usada só se a URL final for direta |
| `TOKEN` | Requer endpoint de token → incompatível sem servidor |
| `WEB` | Depende de WebView/HTML → incompatível |
| `UNKNOWN` | Sem regra; vira `DIRECT` apenas se o probe confirmar |

### Gerar o relatório de compatibilidade

```bash
npm run analyze-streams            # análise completa + probes (5–10 min)
npm run analyze-streams -- --no-probe     # só classificação estática
```

Resultados salvos em `out/streams-report.json` e `out/streams-detail.json`.

**Resultado típico da análise (playlist + segmento, 25+ hosts):**

```
DIRECT_WORKING  : <N> fontes  → reproduzíveis direto (sem proxy)
HEADER_WORKING  : <N> fontes  → reproduzíveis sem headers
PLAYLIST_ONLY / SEGMENT_4xx  : playlist abre, segmento não entrega
PROTECTED / WEB / DEAD_HOST / TIMEOUT : não reproduzíveis
```

Relatórios: `out/streams-report.json`, `out/streams-detail.json`,
`out/hosts-report.json`, `out/header-working-sources.json`,
`out/direct-working-sources.json`, `out/history/<data>.json`.

## 8. Instalar num cliente Stremio-compatível (mesma máquina)

1. `npm start` e deixe rodando.
2. No cliente: **Addons → Add addon**.
3. Cole `http://localhost:7000/manifest.json` → **Install**.
4. Abra o catálogo → canal → Meta → play.

Um canal só deixa de existir se o stream exigir headers (vai aparecer sem
streams — comportamento honesto, de acordo com o probe).

## 8b. Usar em outros aparelhos (TV/celular)

Clientes Stremio-compatíveis instalam **addons por URL** (não consomem M3U).

### Opção A — servidor local (PC ligado)

1. `npm start` (sobe em `http://localhost:7000`).
2. No cliente: **Addons → Adicionar Addon** → cole `http://localhost:7000` → **Instalar**.
3. Abra o catálogo → canal → play.

Para instalar de **outro aparelho** (celular/TV), o servidor precisa estar
acessível pela rede: use o IP da máquina (ex.: `http://192.168.1.10:7000`),
setando `PUBLIC_URL` para esse endereço e liberando a porta no firewall.
Enquanto o PC estiver ligado, esse modo funciona com o servidor completo.

### Opção B — addon estático em GitHub Pages (sem servidor, PC pode desligar)

O workflow `.github/workflows/playlist.yml` gera um **addon estático** (manifest +
catálogos + streams com links crus) e publica em GitHub Pages todo dia às 04:00
UTC — renovando sozinho os links que rotacionam por sessão:

1. No cliente: **Addons → Adicionar Addon** → cole a **base** do seu Pages
   (`https://<usuário>.github.io/<repo>/`) → **Instalar** (ele adiciona
   `/manifest.json`).
2. Abra o catálogo → canal → play.

Cada canal lista as **fontes** reproduzíveis como opções (ex.: Opção 01/02,
por região/CDN) — cada uma toca **o próprio sinal**. Fontes que só funcionam
com headers ou não foram confirmadas **não aparecem** na lista.

Para gerar localmente (opcional):

```bash
npm run export-addon          # grava out/ (manifest, catalog/, stream/, meta/)
```

Tradeoffs da Opção B: sem servidor/proxy/retry — se o CDN estiver lento pode
voltar a travar às vezes; canal com 503 no momento não abre até normalizar.

### M3U (players que consomem M3U)

A rota `/playlist.m3u` e o arquivo `out/playlist-raw.m3u` continuam disponíveis
para players que **consomem M3U** (TiviMate, Smarters, VLC etc.). Clientes
Stremio-compatíveis **não** usam esse formato.

## 8c. Funcionar 24/7 sem o seu PC

O addon é um servidor Node com proxy HLS — ele precisa de um lugar rodando Node
o tempo todo (não funciona em hospedagem estática como Google Drive/GitHub Pages).
Opções: um VPS grátis/permanente ou qualquer servidor sempre ligado. Após o deploy:

- Instalar `http://<IP>:7000/manifest.json` no cliente (Addons → Adicionar Addon).

> Alternativa sem nenhum servidor: use a **Opção B** acima (addon estático em
> GitHub Pages) — funcional, porém sem as melhorias de proxy/retry.

## 9. Proxy?

Não. Esta versão não contém proxy HLS, reescrita de playlist, segmentos, chaves
ou retransmissão. O fluxo é `API → cliente` direto. Fontes que exigiram proxy
são simplesmente omitidas.

## 10. Segurança

- Sem credenciais/segredos no código; configuração por env.
- Sem SSRF/open proxy, sem bypass de DRM/CAPTCHA, sem WebPlayer/WebView.
- O addon reproduz somente a chamada pública que o app faz.

## 11. Troubleshooting

| Problema | Verifique |
| --- | --- |
| Addon não aparece | Servidor rodando; URL do manifest; JSON em `http://localhost:7000/manifest.json` |
| Catálogo vazio | A API responde? rede/cache |
| Stream não reproduz | O canal exige headers (ver `npm run analyze-streams`); sinal offline |
| EPG vazio | `/epg.xml` sobe? o canal tem `id_canal`? |

## 12. Testes

```bash
npm test
```

Cobre: ids (`maxnet:<cat>:<id>` sem colisão), adapter/normalização, classificador
de fontes, matching por host, gate de fontes e EPG (timezone `-0300`, programa
atual).