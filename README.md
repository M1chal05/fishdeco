# Fishdeco – klubová sbírka dekorací

Sdílená evidence 231 dekorací pro klub. Členové se přihlašují přes Discord
po ověření společného klubového hesla. Jméno se převezme z Discordu; každý
mění jen svoje vlastnictví a ostatní sbírky prohlíží pouze pro čtení.
PINy ani registrace vlastního jména nejsou v běžném provozu dostupné.

První nastavení krok za krokem: [DISCORD_SETUP.md](DISCORD_SETUP.md).
Bez konfigurace Discord aplikace je přihlášení vypnuté.

Pro Cloudflare je připravený backend **Workers + D1** a statické soubory mimo API
nespouštějí Worker. Postup nasazení: [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md).
Lokální `npm run dev` dál používá `node:http` + `node:sqlite`.
Frontend je obyčejný vanilla JS ve složce `public/`.

## Požadavky

- Node.js **22.13 nebo novější** (kvůli vestavěné `node:sqlite`); doporučujeme
  aktuální LTS. Na Windows / PowerShellu postačí instalace z nodejs.org.
- Samotný Node server nemá běhové závislosti. Pro Cloudflare nástroje a kompletní
  testy nainstaluj vývojové závislosti přes `npm ci`.

## Lokální spuštění (PowerShell)

```powershell
cd C:\cesta\k\fishdeco

# volitelné, ale doporučené: vlastní konfigurace
copy .env.example .env
# otevřete .env a nastavte CLUB_PASSWORD

npm run dev
```

Server poběží na `http://127.0.0.1:3000` (lze změnit v `.env`).

`npm run dev` automaticky restartuje server při změně jeho kódu. Po změnách
HTML, CSS nebo klientského JavaScriptu obnovte stránku v prohlížeči.
Pro běžný provoz bez sledování změn použijte `npm start`.

### Přihlášení a klubové heslo

- Discord ověřuje člověka přes OAuth2 s oprávněním `identify`.
- `CLUB_PASSWORD` server ověří před každým novým přihlašovacím tokem.
- Člena identifikuje stálé Discord ID. Shodný nick cizí účet nepřevezme.
- Client Secret patří pouze do serverové konfigurace `.env`.
- Novou členskou databázi a Discord aplikaci nastav podle [DISCORD_SETUP.md](DISCORD_SETUP.md).

### Sběratelé a hlavní sběratelé

- **Sběratel** je dvojice (účet, kolekce) – vzniká automaticky při první úpravě
  položky v dané kolekci. Jeden člen má tedy v každé kolekci nejvýš jednoho
  sběratele, ale může sbírat ve všech kolekcích.
- **Hlavní sběratel** kolekce je nepovinná role: v jedné kolekci ho může držet
  nejvýš jeden člen (nárokuje si ho sám přes API), jeden člen ale může být
  hlavním sběratelem ve **více kolekcích** současně. Zrušit ho může jen ten,
  kdo ho drží.
- **Zděděné záznamy** (sběratelé z doby před účty) zůstávají viditelné, jsou
  ale **jen ke čtení** (nemají `user_id`). Přiřadí se konkrétnímu účtu ručně
  skriptem `scripts/assign-legacy.mjs` – viz níže.

### Konfigurace (proměnné prostředí / .env)

| Proměnná        | Výchozí      | Popis |
|-----------------|--------------|-------|
| `CLUB_PASSWORD` | –            | Společné heslo pro ověření před přihlášením přes Discord. |
| `PORT`          | `3000`       | Port serveru. |
| `HOST`          | `127.0.0.1`  | Adresa poslouchání. |
| `DATA_DIR`      | `./data`     | Adresář s databází `club.sqlite` a `catalog.json`. Nastavte na trvalý svazek při nasazení / při testech na dočasný adresář. |
| `COOKIE_SECURE` | `false`      | Na `true` za HTTPS reverzní proxy (cookie `Secure`). |

## Katalog (`data/catalog.json`)

Katalog je naplněn importem z veřejné wiki (viz níže) – 15 kolekcí / 231
dekorací. Při ručních úpravách respektujte stejný formát:

```json
{
  "collections": [
    {
      "id": "keramicke-dekorace",
      "name": "Keramické dekorace",
      "description": "volitelné",
      "items": [
        { "id": "amfora-mala", "name": "Malá amfora", "description": "volitelné" }
      ]
    }
  ]
}
```

- `id` kolekcí a předmětů si zvolte **jednou a trvale** (např. slug nebo UUID) –
  slouží jako stabilní klíč, na který se vážou odškrtnutí sběratelů. `id`
  předmětů musí být jedinečné v celém souboru.
- Volitelná metadata položky: `image`, `sourceUrl`, `set`, `type`, `rarity`,
  `availability`, `level` (číslo/`null`), `season`, `source`, `price`
  (číslo/`null`), `width`, `height`, `acquisitionDetail`. Kolekce může mít navíc
  `sourceUrl`, kořen `meta`. Hodnoty se **striktně validují**: `image` musí být
  lokální cesta `/assets/decorations/<soubor>.<přípona>`, `sourceUrl` jen
  `https://(www.)fishaofunwiki.com/…`, čísla konečná a ≥ 0. Neznámá pole se ze
  servovaného stavu vyřadí.
- Node server čte změny katalogu bez restartu. Cloudflare katalog přibaluje při
  nasazení, po importu tedy spusť `npm run cf:deploy`. Frontend kontroluje změny
  každých 30 s jen ve viditelné kartě a hned při návratu na ni.
- Node server soubor při každém čtení stavu **plně validuje**; při chybě API vrátí
  srozumitelnou chybu. Data sběratelů se **nikdy nemažou** – kolekce/předmět
  odebraný z katalogu jen přestane být ve stavu vidět (sběratel zůstane uložen;
  pokud položku do katalogu vrátíte se stejným `id`, odškrtnutí se znovu objeví).
- Cloudflare build katalog zvaliduje před nasazením a odmítne i neznámá pole,
  aby se do zabaleného katalogu nedostala nechtěná data.
- `examples/catalog.example.json` je jen **ukázka formátu** – server ho nenačítá.

České názvy všech sad a dekorací jsou spravované v `data/names.cs.json`.
Import je přidává jako `nameCs`, původní anglické `name` a stabilní identifikátory
zachovává. Jde o vlastní české překlady pro tento klubový přehled.
Vyhledávání podporuje oba jazyky i zadání bez diakritiky. Ikony sad se při importu
objeví na stránce wiki a stáhnou lokálně; u skupiny Ostatní je použité logo dekorací,
protože wiki pro tuto skupinu samostatný odznak nemá. Report uvádí zdroje ikon
i případné chybějící překlady nově přidaných položek.

## Import katalogu z FishaoFunWiki

Katalog pochází z veřejné komunitní wiki
<https://www.fishaofunwiki.com/category/decorations> (data ani obrázky nejsou
naše – v katalogu proto zůstává atribuce `meta.source`/`sourceUrl`).

```powershell
npm run import        # nebo: node scripts/import-wiki.mjs [--dry-run] [volby]
```

Importer (`scripts/import-wiki.mjs`):

1. Načte stránku kategorie → najde hlavní JS modul → v něm dynamicky vyhledá
   aktuální chunk `assets/decorations-*.js` (hash v názvu se nemusí shodovat
   s posledním importem).
2. Z chunku vytáhne vestavěný `JSON.parse(…)` payload **čistě jako data**
   (žádné eval vzdáleného kódu) a všechna pole zvaliduje.
3. Stáhne všechny obrázky dekorací (max ~5 paralelně) do
   `public/assets/decorations/<slug>.webp` – aplikace tak nezávisí na
   hotlinku. Každý soubor ověří: HTTP 200, ne-HTML obsah, WEBP signatura.
4. Seskupí položky podle původních sad (`set`) – `id` kolekce je kebab-case
   názvu sady (`"Gold Set"` → `gold-set`, `"Other"` → `other`), `id` položky je
   původní `slug` ze zdroje. Hodnoty atributů se přebírají beze změn
   (včetně `Unknown`); `price` je surová hodnota sloupce „Price / Home points"
   – neznamená nutně nákupní cenu v jedné měně.
5. Teprve když je vše kompletní, **atomicky** zapíše `data/catalog.json`
   (tmp + rename) a report `data/import-report.json`. Při jakékoli chybě
   (chybějící obrázek, duplicita, nevalidní payload) import selže a produkční
   katalog zůstane beze změn. Databáze `club.sqlite` se nikdy nedotýká.

Report `data/import-report.json` obsahuje zdrojové URL (stránka, modul, chunk),
datum a čas stažení, `sha256` hash zdrojového chunku i vygenerovaného katalogu,
počty podle sad, seznam stažených/chybějících obrázků a diff `id` proti
předchozímu katalogu. Neobsahuje žádná tajemství.

Volby: `--out <soubor>`, `--assets-dir <adresář>`, `--report <soubor>`,
`--concurrency <1–6>`, `--dry-run` (vše stáhne a ověří, nic nezapíše).
Zdroj lze přesměrovat proměnnou `FISHDECO_WIKI_ORIGIN` (např. na lokální
fixture server v testech).

## Nasazení (produkce)

- Běží **jedna** instance `node server.mjs` (např. jako služba / systemd unit /
  `pm2`). Data jsou sdílená přes SQLite soubor.
- `DATA_DIR` nasměrujte na **persistentní svazek**, aby databáze přežila
  restarty a přesuny.
- Před server postavte **reverzní proxy s HTTPS** (Caddy, nginx, Apache…) –
  server samotný mluví jen HTTP, takže nechte `HOST=127.0.0.1` a proxy ať
  forwarduje na `http://127.0.0.1:3000`. V `.env` pak nastavte
  `COOKIE_SECURE=true`.
- Aplikace nepotřebuje žádné externí účty ani služby.

### Zálohy

Nejjistější je zálohovat při **vypnutém** serveru – zkopírujte
`data/club.sqlite`. Za běhu použijte SQLite příkaz `VACUUM INTO` nebo
`sqlite3 .backup`, které zajistí konzistentní kopii i během zápisů.
Katalog `data/catalog.json` zálohujte spolu s databází.

Před každou **migrací schématu existující databáze** server automaticky
vytvoří konzistentní zálohu (`VACUUM INTO`) jako
`data/club-backup-<čas>-<náhodné>.sqlite` a její jméno vypíše do konzole.

### Migrace staré databáze (sběratelé bez účtu)

První spuštění nové verze nad existující databází automaticky (v transakci)
přidá tabulky `users`, `primary_assignments` a sloupec `user_id` do `sessions`
a `collectors`. Dosavadní sběratelé a jejich odškrtnutí **zůstanou nedotčení**
– jen nemají vlastníka (`user_id IS NULL`), jsou viditelní všem a jsou jen ke
čtení. Registrace účtu se stejným jménem zděděné záznamy **nepřebírá**
automaticky.

Pro explicitní přiřazení zděděných záznamů k existujícímu účtu slouží offline
skript – spusťte ho vždy při **vypnutém** serveru:

```powershell
# nejdřív založte účet přes registraci v aplikaci, pak:
node scripts/assign-legacy.mjs --from "Pepa" --to "Pepa Novák"
node scripts/assign-legacy.mjs --from "Pepa" --to "Pepa Novák" --dry-run  # jen náhled
```

- `--from` je jméno zděděných (nepřiřazených) sběratelů, `--to` jméno
  registrovaného účtu. Data adresáře lze změnit přes `--data-dir`/`DATA_DIR`.
- Všechny nepřiřazené záznamy daného jména se přepíší na účet v jedné
  transakci; odškrtnuté předměty zůstanou zachovány.
- Kdyby přiřazení kolidovalo se záznamem, který účet ve stejné kolekci už má,
  skript **selže a nic nezmění** (neslučuje ani nemaže data).
- Pokud přebíráte starší záznamy, přiřaďte je po registraci ještě před prvním
  odškrtnutím ve stejných sadách, abyste nevytvořili kolidující nový záznam.
- Skript nikdy nevytváří účty ani hesla – bere jen jména.

## API

| Metoda | Cesta | Popis |
|--------|-------|-------|
| `GET`  | `/api/session` | `{authenticated, user}` (`user` je `{id,name}` nebo `null`) |
| `POST` | `/api/auth/discord/start` | `{mode:"login", clubPassword}` → `{url}` |
| `GET` | `/api/auth/discord/callback` | Ověřený návrat z Discordu → přihlašovací cookie |
| `POST` | `/api/register`, `/api/login` | V běžném provozu vypnuté → `410` |
| `POST` | `/api/logout` | `{authenticated:false, user:null}` |
| `GET`  | `/api/state` | (auth) `{collections, collectors, users, currentUser, primaryAssignments}`, `Cache-Control: no-store` |
| `PUT`  | `/api/me/collections/:collectionId/items/:itemId` | (auth) `{owned:boolean}` → `{collector}`; při první úpravě založí vlastního sběratele |
| `PUT`  | `/api/collections/:collectionId/primary` | (auth) `{primary:boolean}` → `{primaryAssignments}`; cizí obsazení `409`, cizí zrušení `403` |
| `POST` | `/api/collectors` | odebráno → `410` |
| `PUT`  | `/api/collectors/:id/items/:itemId` | (auth) jen vlastní sběratel; zděděný (`user_id NULL`) nebo cizí → `403` |

Objekty: `user`/`currentUser`/`users[]` jsou jen `{id,name}`; `collector` je
`{id, name, collectionId, ownedItemIds, userId}` (`userId` může být `null` u
zděděných záznamů); `primaryAssignments[]` je `{collectionId, userId}`.
Chyby `{error}` jsou česky.

Bezpečnost: session cookie `HttpOnly; SameSite=Strict` (+ `Secure` dle
`COOKIE_SECURE`), expirace na serveru (90 dní), rate limit registrace/přihlášení
(5 pokusů / min / IP + jméno), kontrola `Origin` u mutací, limit těla 16 kB,
PINy a pozvánka jen jako scrypt hashe s unikátní solí, porovnání v konstantním
čase, obecná chybová hláška přihlášení, relace bez vazby na účet se neuznává.

## Testy

```powershell
npm test
```

Testy (`tests/backend.test.mjs`, `node:test`) běží na dočasných adresářích
a náhodných portech – nesahají na `data/`. Pokrývají registraci/přihlášení,
izolaci uživatelů, migraci v1→v2 i skript `assign-legacy.mjs`.

Volitelný test skutečného prohlížeče je v `scripts/verify-ui.mjs`. Potřebuje
Playwright a jeho Chromium; při instalaci mimo projekt nastavte proměnnou
`PLAYWRIGHT_MODULE` na úplnou cestu k `playwright/index.mjs` a spusťte
`node scripts/verify-ui.mjs`. Spustí `verify-accounts-ui.mjs`: registraci a
přihlášení dvou členů přes testovací Discord, zákaz úprav cizího vlastnictví, prohlížení
jiného člena během ukládání, přehled dokončení, hlavní sběratele, mobilní
šířky i prázdný katalog.

`node scripts/verify-catalog-ui.mjs` navíc ověří skutečný importovaný katalog,
dekódování všech 231 obrázků v Chromium, hledání a filtry, ukládání vlastnictví
a oba motivy na šesti šířkách. Používá kopii katalogu a dočasnou databázi.

## Struktura

```
server.mjs                  backend (API + statické soubory)
data/catalog.json           katalog kolekcí (importovaný z FishaoFunWiki)
data/import-report.json     report posledního importu katalogu
data/club.sqlite            databáze (vznikne při spuštění, není v gitu)
data/club-backup-*.sqlite   automatické zálohy před migrací schématu
examples/catalog.example.json  ukázka formátu katalogu
scripts/import-wiki.mjs     import katalogu + obrázků z FishaoFunWiki
scripts/assign-legacy.mjs   offline přiřazení zděděných sběratelů k účtu
tests/backend.test.mjs      integrační testy
public/                     frontend (vanilla JS)
public/assets/decorations/  stažené obrázky dekorací (<slug>.webp)
tokens.css                  sdílené CSS proměnné (servováno z kořene)
```

### Discord OAuth2

Nastavení popisuje [DISCORD_SETUP.md](DISCORD_SETUP.md). Používají se proměnné
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` a `DISCORD_REDIRECT_URI`.

PIN vrstva zůstala pouze pro interní kompatibilitní testy s explicitním
parametrem při vytvoření testovací aplikace. Veřejným požadavkem ani proměnnou
prostředí ji nelze zapnout. OAuth testy používají testovací odpovědi, nikoliv
skutečný Discord účet; skutečné přihlášení je nutné projít po konfiguraci.

Pro prázdný seznam členů nastav `DATA_DIR=./data/discord-club` a zkopíruj
tam `data/catalog.json`. Nová databáze vznikne automaticky; stará se nemaže.

`localhost` a `127.0.0.1` jsou různé hosty pro cookies: web otevírej přes stejný
host, který je v návratové adrese. Veřejné nasazení vyžaduje HTTPS.
