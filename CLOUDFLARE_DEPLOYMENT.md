# Nasazení na Cloudflare Workers + D1

Aplikace má připravený backend `cloudflare/worker.mjs` a D1 migraci.
Frontend i všech 231 obrázků obsluhují Workers Static Assets. Backend se spouští
jen pro `/api/*`. Členská data jsou v D1; katalog je součástí nasazení.
Lokální Node server a jeho databáze zůstávají samostatné.

## První nasazení

V PowerShellu v adresáři projektu:

```powershell
npm ci
npx wrangler login
npx wrangler d1 create fishdeco
```

Poslední příkaz vypíše `database_id`. Vlož ho do `wrangler.jsonc` místo
`00000000-0000-0000-0000-000000000000`. Název databáze nech `fishdeco`, binding `DB`.
Zkontroluj, že máš na účtu plán **Workers Free**, pokud chceš zůstat u bezplatných limitů.

```powershell
npm run cf:db:remote
npm run cf:deploy
```

Deploy vypíše adresu, například `https://fishdeco.tvuj-ucet.workers.dev`.
V této chvíli bude přihlášení ještě vypnuté, protože nejsou nastavená tajemství.

V [Discord Developer Portalu](https://discord.com/developers/applications) otevři aplikaci
s Client ID `1571159915870031894`, přejdi do **OAuth2 → Redirects**, přidej přesně:

```text
https://fishdeco.tvuj-ucet.workers.dev/api/auth/discord/callback
```

Použij skutečnou adresu z deploye. Ulož změnu. Původní localhost redirect může zůstat
kvůli lokálnímu vývoji.

Následující příkazy si bezpečně vyžádají hodnoty v terminálu. Nedávej je přímo do
příkazu, konfigurace, chatu ani veřejného repozitáře:

```powershell
npx wrangler secret put CLUB_PASSWORD
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_REDIRECT_URI
```

- `CLUB_PASSWORD`: společné klubové heslo.
- `DISCORD_CLIENT_SECRET`: Client Secret z Discord OAuth2.
- `DISCORD_REDIRECT_URI`: celá HTTPS callback adresa přidaná do Discordu.

Client ID je veřejný údaj a už je ve `wrangler.jsonc`. Cloudflare tajemství nenahrává
automaticky z lokálního `.env`. Po nastavení všech tří hodnot přihlášení začne fungovat.
Není potřeba Discord bot ani oprávnění ke čtení zpráv; aplikace žádá pouze `identify`.

Otevři web, zadej klubové heslo a přihlas se přes Discord. Zkontroluj uložení jedné
dekorace po obnovení stránky a pohled na jiného člena. D1 je nová členská databáze;
lokální data se automaticky nepřenášejí a zůstávají zachovaná na počítači.

## Další změny

```powershell
npm test
npm run cf:check
npm run cf:deploy
```

`cf:check` pouze sestaví balíček, nic nepublikuje. Build kopíruje výhradně `public/`
a `tokens.css` do ignorovaného adresáře `.cloudflare-assets/`. `.env`, databáze ani
zdrojové skripty se jako statické soubory nepublikují.
Budoucí databázové migrace spusť před deployem přes `npm run cf:db:remote`.

Pokud přidáš vlastní doménu, nastav ji ve Workers → Settings → Domains & Routes,
přidej nový callback v Discordu a aktualizuj `DISCORD_REDIRECT_URI` stejným příkazem.

## Lokální Cloudflare vývoj

Běžné `npm run dev` dál spouští původní Node server na portu 3000.
Pro ověření přímo na Workers použij:

```powershell
Copy-Item .dev.vars.example .dev.vars
# Doplň lokálně CLUB_PASSWORD a DISCORD_CLIENT_SECRET do .dev.vars.
npm run cf:db:local
npm run cf:dev
```

V Discord Redirects musí být i `http://localhost:8787/api/auth/discord/callback`.
Používej přesně `http://localhost:8787`, aby souhlasily host i redirect.
Lokální D1 ve `.wrangler/` je oddělená od vzdálené databáze i od Node databáze.
`.dev.vars` je ignorovaný soubor s tajemstvími.

## Spotřeba a obnovování

- Při otevření se načte relace a aktuální data.
- Přihlášená **viditelná karta** kontroluje změny každých **30 sekund**.
- Ve skryté kartě se časovač zastaví. Při návratu se data obnoví hned.
- Zavřený web neposílá žádné dotazy. Aplikace nemá cron ani pravidelnou serverovou úlohu.
- Nezměněná data vrací `304`: databáze ověří relaci a jednu revizi, neprochází všechny
  dekorace a sběratele. Kontrola nic do databáze nezapisuje.
- Obrázky, HTML, CSS a JS se obsluhují přímo jako statické soubory.

Například 10 členů s jednou viditelnou kartou po 4 hodiny denně udělá asi 4 800
pravidelných API dotazů za den, navíc přístupy, přihlášení a ukládání změn.
Každá další viditelná karta má vlastní časovač.

Podle dokumentace ověřené 14. 11. 2026 má Workers Free 100 000 dynamických požadavků
za den a 10 ms CPU na požadavek. D1 Free má 5 milionů přečtených řádků denně,
100 000 zapsaných řádků denně a 5 GB celkového úložiště. Čtou se počty skutečně
procházených řádků včetně práce s indexy, ne jen počty SQL dotazů. Limity se sdílejí
s dalšími aplikacemi na stejném účtu; nejde o záruku proti úmyslnému zahlcení.
Při dosažení bezplatných limitů mohou API požadavky selhávat. Placený plán aplikace
sama nezapíná. Spotřebu sleduj v přehledu Workers a D1 Metrics v Cloudflare.

Zdroje: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

## Přihlášení a zabezpečení

Relace trvá 90 dní od přihlášení. Obnovení stránky ani návštěva v rámci platné relace
znovu nevyžadují Discord a klubové heslo. Odhlášení relaci na serveru zruší.
Cookies jsou HttpOnly, na HTTPS také Secure; OAuth má jednorázový stav v D1,
vazbu na prohlížeč a PKCE. Access token Discordu se neukládá. V D1 jsou pouze
otisky tokenů relací. Oprávnění k zápisu vždy určuje přihlášený účet.

Změna klubového hesla ovlivní nová přihlášení, sama neodhlásí existující relace.
Pokud potřebuješ všechny odhlásit, můžeš vědomě zrušit všechny relace v D1:

```powershell
npx wrangler d1 execute fishdeco --remote --command "DELETE FROM sessions"
```

Tento příkaz nemaže účty ani vlastnictví dekorací; jen vyžádá nové přihlášení.
