# Max Net TV — Addon para Stremio (sem servidor próprio)

Addon de TV ao vivo que consome **diretamente** as APIs públicas usadas pelo
aplicativo Max Net TV (`com.exploudapps.maxnettv`, v12.4). Este projeto **não**
mantém servidor próprio, **não** tem proxy HLS próprio, **não** exige VPS/Docker
para funcionar — ele apenas entrega ao Stremio os streams HLS que funcionam
**diretamente**, sem headers especiais.

---

## 1. O que é

- Catálogos de canais (Abertos, Esportes, Notícias, Infantil, Variedades,
  Documentários, Filmes & Séries, 24 Horas, Eventos + Todos) vindos de
  `https://explouddev.com.br/api/canais/*`.
- Meta de cada canal com logo e "no ar agora" (EPG XMLTV ~9 MB).
- Streams **somente diretos**: cada fonte é classificada e só é entregue se um
  probe HTTP sem headers confirmar que é uma playlist HLS reproduzível.
- Busca por nome via `/api/canais/todos?search=`.

## 2. Limitação real do Stremio (importante)

Verificado na documentação oficial (`stremio-addon-sdk`, protocolo): um addon
tradicional do Stremio **precisa ser servido por HTTP/HTTPS** (ou IPFS). Não
existe instalação por arquivo local. Portanto:

> "Não é possível cumprir o requisito de zero servidor com um addon tradicional
> do Stremio **para outros dispositivos**."

Na prática, há dois modos de uso:

```
PC (mesma máquina do Stremio)  →  Node.js local  →  Stremio desktop
```

Você roda `npm start`, instala `http://localhost:7000/manifest.json` e o addon
funciona sem nenhuma hospedagem/VPS/domínio, enquanto o processo estiver no ar.
Para **outros dispositivos / sem o PC ligado**, existe o addon **estático** em
GitHub Pages (ver seção 8b — Opção B): o workflow gera manifest + catálogos +
streams com links crus e publica tudo em gh-pages, renovando os links diariamente.

## 3. Requisitos

- Node.js ≥ 18 (testado com Node 24).
- Stremio desktop no mesmo computador (para instalar o addon local).

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
| `API_BASE_URL` | `https://explouddev.com.br` | Base da API |
| `EPG_BASE_URL` | `https://explouddev.com` | Fonte do XMLTV |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |
| `CHANNELS_TTL_MS` | `600000` | Cache de canais (10 min) |
| `EPG_TTL_MS` | `21600000` | Cache do EPG (6 h) |
| `PROBE_TTL_MS` | `600000` | Cache do resultado dos probes (10 min) |
| `PLAYER_UA` | `DVPlayer/35 (Android 9)` | UA usado nos probes |

## 6. Endpoints

- `/health` — status do servidor.
- `/manifest.json` — manifest do addon.
- `/catalog/channel/maxnet-<categoria>.json` — catálogos.
- `/catalog/channel/maxnet-todos/search=<q>.json` — busca.
- `/meta/channel/maxnet-<cat>:<id>.json` — detalhes + programa atual.
- `/stream/channel/maxnet-<cat>:<id>.json` — streams (diretos ou via proxy).
- `/epg.xml` — XMLTV cru para players externos (DizqueTV/Telly/Jellyfin).
- `/playlist.m3u` — lista M3U dos canais reproduzíveis (para Nuvio/players IPTV).

## 7. Catálogo somente com canais reproduzíveis

Por padrão (`ONLY_COMPATIBLE=true`), o addon exibe **apenas os canais que têm
stream direto confirmado**. A lista é gravada pelo script de análise em

```
out/compatible-channels.json
```

- Para atualizar: rode `npm run analyze-streams` (regrava o arquivo com o que
  estiver no ar naquele momento; alguns canais saem/entram).
- `ONLY_COMPATIBLE=false` volta a listar todos os 338 canais (a maioria sem
  play, como antes).
- `meta` e `stream` continuam respondendo para qualquer id — se o Stremio
  tiver canais antigos em cache, eles ainda resolvem (e o stream segue
  honesto: só aparece se o probe confirmar).

## 8. Proxy de headers (somente para HEADER_WORKING)

Desde o diagnóstico v2, fontes **HEADER_WORKING** são entregues ao Stremio
através de um proxy local de headers (`/proxy`) que:

- injeta `User-Agent`/`Referer`/`Origin` extraídos das regras do próprio app;
- segue redirects validando cada destino contra a allowlist (anti SSRF/open proxy);
- reescreve a playlist (segmentos, `#EXT-X-KEY`, `#EXT-X-MEDIA` → `/proxy?u=...`);
- repassa segmentos em streaming (sem buffer de vídeo);
- bloqueia IPs privados/locais, URLs arbitrárias e hosts não conhecidos (403);
- **não** gera/burla JWT, token ou credencial (PROTECTED fica de fora).

Fluxo:
```
DIRECT  →  Stremio → URL original (sem proxy)
HEADER  →  Stremio → /proxy?u=<link> → headers da regra → UPSTREAM (playlist+segmentos)
```

A lista de fontes HEADER_WORKING vem de `out/header-working-sources.json`
(regravada por `npm run analyze-streams`). O gate é **por host**: fontes de
hosts confirmados entram no proxy (links dns rotacionam por sessão, o host é
fixo). Desative com `PROXY_ENABLED=false`.

Tolerância a upstream lento/flaky (playlist):

- `PROXY_PLAYLIST_CACHE_MS=2500` — reloads de playlist são servidos do cache
  (~0,2s) em vez de esperar o upstream (que pode levar >1,5s);
- `PROXY_PLAYLIST_STALE_MS=15000` — se o upstream falhar (5xx/rede), o proxy
  devolve a última playlist boa (stale-on-error) em vez de 502, evitando
  travadas no player;
- `PROXY_RETRY_TIMEOUT_MS=5000` — retry curto quando o cache não é suficiente;
- `PROXY_WARM_REFRESH_MS=2000` / `PROXY_WARM_IDLE_MS=6000` — enquanto um canal
  está aberto, o proxy refresca a playlist em background a cada 2s, então o
  reload do player (a cada ~10s) sai do cache em ~ms em vez de esperar os ~2,4s
  do upstream dns;
- `PROXY_DIRECT_SEGMENTS=false` — por padrão os segmentos passam pelo proxy com
  os headers da regra (o CDN entrega rápido com UA Chrome; alguns clients não
  são aceitos direto). Com `true`, segmentos do mesmo host da playlist vão
  diretos ao upstream;
- `PROXY_SEGMENT_CACHE_MAX=6` / `PROXY_PREFETCH_AHEAD=2` — o proxy **pré-busca**
  os próximos segmentos em background (a partir da playlist aquecida) e o player
  recebe na hora do cache local. Isso protege a reprodução quando o CDN está
  lento/variável (a Warner, ~5,5 Mbps, trava quando o CDN cai abaixo do bitrate;
  o prefetch suaviza isso).

O catálogo usa gate **por host** além da lista de ids: um canal aparece se tem
≥1 fonte em host confirmado HEADER_WORKING (links dns flutuam; o host é o que
vale). Por isso o catálogo pode mostrar mais canais que `compatible-channels.json`.

## 9. Classificação e análise das fontes (v2)

Cada fonte é classificada pelas regras de `app_start.php` (`streams_info[]`) e
por **probe HTTP real sem headers** (UA de player, sem Referer):

| Classe | Significado |
| --- | --- |
| `DIRECT` | Playlist HLS confirmada sem headers → entregue ao Stremio |
| `DIRECT_WITH_HEADERS` | Exige Referer/UA/Origin (ex.: `dns.explouddev.com`) → **não** entregue |
| `GETLINK` | Resolve via `/getlink.php`; usada só se a URL final for direta |
| `TOKEN` | Requer endpoint de token → incompatível sem servidor |
| `WEB` | Depende de WebView/HTML (ex.: `sinal.cc`) → incompatível |
| `UNKNOWN` | Sem regra; vira `DIRECT` apenas se o probe confirmar |

### Gerar o relatório de compatibilidade

```bash
npm run analyze-streams            # análise completa + probes (5–10 min)
npm run analyze-streams -- --no-probe     # só classificação estática
```

Resultados salvos em `out/streams-report.json` e `out/streams-detail.json`.

**Resultado da análise v2 (playlist + segmento, 25+ hosts):**

```
DIRECT_WORKING  : <N> fontes  → reproduzíveis direto (sem proxy)
HEADER_WORKING  : <N> fontes  → reproduzíveis via proxy de headers (sem JWT)
PLAYLIST_ONLY / SEGMENT_4xx  : playlist abre, segmento não entrega
PROTECTED / WEB / DEAD_HOST / TIMEOUT : não reproduzíveis
```

Relatórios: `out/streams-report.json`, `out/streams-detail.json`,
`out/hosts-report.json`, `out/header-working-sources.json`, `out/history/<data>.json`.

**Achado chave:** a fonte mais comum (`dns.explouddev.com`) abre playlist E
segmento (MPEG-TS real) quando mandamos os headers da regra (UA Chrome) — e o
segmento deve ser resolvido contra o host do **redirect** (CDN `*.mantoxp.click`).
Sem JWT. Meu teste antigo resolvia o segmento contra o host errado (404); era
falso negativo.

**vivatele (SBT/Band/Rá Tim Bum):** a URL `live/{user}/{pass}/{slot}.m3u8`
redireciona (302) para `/auth/{slot}.m3u8?token=...`, que devolve uma playlist
**AES-128 real** com segmentos `/hls/{n}_{seq}.ts?token=...` e chave `/key/...`.
Playlist, segmentos e chave respondem **sem headers** — ou seja, é um HLS
genuíno e direto. Porém o slot pode ficar vazio (0 bytes) quando a sessão sai
do ar; nesses casos o probe falha e o addon não entrega o stream (honesto).

## 8. Instalar no Stremio (mesma máquina)

1. `npm start` e deixe rodando.
2. No Stremio desktop: **Addons → Add addon**.
3. Cole `http://localhost:7000/manifest.json` → **Install**.
4. Abra o catálogo Max Net TV → canal → Meta → play.

Um canal só para de existir se o stream exigir headers (vai aparecer sem
streams — comportamento honesto, de acordo com o probe).

## 8b. Usar no Nuvio

O Nuvio (nuvio.tv) é um app **baseado em addons** (protocolo Stremio) — ele **não**
consome lista M3U. Para usar os canais no Nuvio, instale o **addon** por URL:

### Opção A — servidor local (PC ligado)

1. `npm start` (sobe em `http://localhost:7000`).
2. No Nuvio: **Addons → Adicionar Addon** → cole `http://localhost:7000` → **Instalar**.
3. Abra o catálogo Max Net TV → canal → play.

Para instalar de **outro aparelho** (celular/TV), o servidor precisa estar
acessível pela rede: use o IP da máquina (ex.: `http://192.168.1.10:7000`),
setando `PUBLIC_URL`/`PROXY_BASE_URL` para esse endereço e liberando a porta no
firewall. Enquanto o PC estiver ligado, esse modo tem **proxy/prefetch/retry**
(a reprodução é mais suave quando o CDN está lento).

### Opção B — addon estático em GitHub Pages (sem servidor, PC pode desligar)

O workflow `.github/workflows/playlist.yml` gera um **addon estático** (manifest +
catálogos + streams com links crus) e publica em GitHub Pages todo dia às 04:00
UTC — renovando sozinho os links `dns` (que rotacionam por sessão):

1. No Nuvio: **Addons → Adicionar Addon** → cole a **base** do seu Pages
   (`https://<usuario>.github.io/<repo>/`) → **Instalar** (ele adiciona
   `/manifest.json`).
2. Abra o catálogo Max Net TV → canal → play.

Cada canal lista as **fontes** reproduzíveis como opções (ex.: Globo SP, Globo RJ,
Opção 01/02) — cada uma toca **o próprio sinal**. Fontes que só funcionam via
proxy (hosts não confirmados) **não aparecem** na lista.

Para gerar localmente (opcional):

```bash
npm run export-addon          # grava out/ (manifest, catalog/, stream/, meta/)
```

Tradeoffs da Opção B: sem proxy/prefetch/retry — se o CDN estiver lento pode
voltar a travar às vezes; canal com 503 no momento não abre até normalizar.

### M3U (players IPTV clássicos)

A rota `/playlist.m3u` e o arquivo `out/playlist-raw.m3u` continuam disponíveis
para players que **consomem M3U** (TiviMate, Smarters, VLC, etc.) — mas o **Nuvio
não** usa esse formato.

## 8c. Funcionar 24/7 sem o seu PC

O addon é um servidor Node com proxy HLS — ele precisa de um lugar rodando Node
o tempo todo (não funciona em hospedagem estática como Google Drive/GitHub Pages).
Guia passo a passo no arquivo `Como Instalar no Oracle Cloud.md` (Oracle Cloud
Always Free, VPS grátis e permanente). Após o deploy:

- Stremio: instalar `http://<IP>:7000/manifest.json`.
- Nuvio: instalar o addon `http://<IP>:7000` (Addons → Adicionar Addon).

## 9. Proxy?

Não. Esta versão não contém proxy HLS, reescrita de playlist, segmentos, chaves
ou retransmissão. O fluxo é `API → Stremio` direto. Fontes que exigiram proxy
são simplesmente omitidas.

## 10. Segurança

- Sem credenciais/segredos no código; configuração por env.
- Sem SSRF/open proxy, sem bypass de DRM/CAPTCHA, sem WebPlayer/WebView.
- O addon reproduz somente a chamada pública que o app faz.

## 11. Troubleshooting

| Problema | Verifique |
| --- | --- |
| Addon não aparece | Servidor rodando; URL do manifest; JSON em `http://localhost:7000/manifest.json` |
| Catálogo vazio | `GET /api/canais/todos` responde? rede/cache |
| Stream não reproduz | O canal exige headers (ver `npm run analyze-streams`); sinal offline |
| EPG vazio | `/epg.xml` sobe? o canal tem `id_canal`? |

## 12. Testes

```bash
npm test
```

Cobre: ids (`maxnet:<cat>:<id>` sem colisão), adapter/normalização, classificador
de fontes, matching por host e EPG (timezone `-0300`, programa atual).