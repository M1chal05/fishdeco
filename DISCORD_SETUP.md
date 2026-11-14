# Přihlášení přes Discord

Člen zadá společné klubové heslo a přihlásí se přes Discord. Aplikace převezme
zobrazované jméno (případně uživatelské jméno). Účet se váže na Discord ID,
nikoliv na přezdívku. PIN ani registrace vlastního jména se nepoužívají.

## 1. Založení aplikace

1. Otevři [Discord Developer Portal](https://discord.com/developers/applications)
   a přihlas se svým Discord účtem.
2. Klikni na **New Application**, pojmenuj ji například **Fishdeco** a vytvoř ji.
3. V části **OAuth2** přidej do **Redirects** přesně tuto adresu a ulož ji:

   ```text
   http://localhost:3000/api/auth/discord/callback
   ```

4. V části **OAuth2** najdeš **Client ID** a **Client Secret**. Secret je tajný
   klíč serveru: nesdílej ho s členy klubu, neposílej ho do chatu ani na screenshotu.
   Pokud se neukazuje, Discord umožňuje jeho obnovení přes **Reset Secret**.
   U existující používané aplikace reset zneplatní dosavadní secret.

Není potřeba vytvářet bota ani mu dávat oprávnění na klubovém serveru.
Aplikace si sama vyžádá pouze rozsah `identify` pro základní profil.
Přezdívka specifická pro konkrétní Discord server není v tomto rozsahu dostupná.

## 2. Nastavení serveru

V adresáři projektu otevři `.env` (pokud ho ještě nemáš, zkopíruj `.env.example`).
Existující `.env` nepřepisuj příkazem kopírování. Doplň do něj svoje hodnoty:

```dotenv
CLUB_PASSWORD=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/discord/callback
HOST=127.0.0.1
PORT=3000
DATA_DIR=./data/discord-club
```

`CLUB_PASSWORD` je společné klubové heslo; můžeš ponechat to dosavadní.
Do dvou polí pro Discord patří Client ID a Client Secret z portálu. Prázdné
hodnoty výše jsou místa pro doplnění, nejsou to funkční přihlašovací údaje.
Soubor `.env` je ignorovaný Gitem a načítá ho pouze server.

## 3. Nový seznam členů

Pro nový klub používáme samostatný adresář databáze. V PowerShellu v projektu:

```powershell
New-Item -ItemType Directory -Force .\data\discord-club
Copy-Item .\data\catalog.json .\data\discord-club\catalog.json
npm run dev
```

Server vytvoří novou databázi automaticky. Starý soubor `data/club.sqlite`
se nemaže. Adresář `data/discord-club` musí být nový, pokud v něm chceš mít
prázdný seznam členů. Obrázky se používají dál z `public/assets/decorations`.

Otevři **http://localhost:3000**, nejprve zadej klubové heslo a potvrď jeho
ověření. Teprve potom se objeví tlačítko **Přihlásit přes Discord**.
Na Discordu zkontroluj název aplikace a potvrď
přístup k profilu. Při prvním přihlášení se vytvoří člen, při dalších se
otevře stejný účet a jeho sbírky.

Přihlášení v tomto prohlížeči zůstává uložené 90 dní od přihlášení, i po
zavření okna. Během této doby se aplikace otevře rovnou bez hesla a Discordu.
Odhlášení, smazání cookies nebo vypršení relace vyžaduje nové přihlášení.

Používej přesně `localhost`, nikoliv `127.0.0.1`, pokud máš v návratové
adrese nastavený `localhost`. Jinak se nemusí přenést cookie ověřující návrat.
Po změně `.env` restartuj server přes Ctrl+C a `npm run dev`.

## 4. Veřejné nasazení

V portálu přidej návratovou adresu se skutečnou doménou, například
`https://tvoje-domena.cz/api/auth/discord/callback`, a stejnou hodnotu nastav
do `DISCORD_REDIRECT_URI`. Web musí běžet přes HTTPS. Pro tento případ server
automaticky nastaví přihlašovacím cookies příznak `Secure`.

Databáze musí být na trvalém disku; zálohuj ji. Soubor `.env`, databázi ani
secret nevystavuj jako veřejné soubory. Server obsluhuje pouze adresář
`public` a soubor designových tokenů.

## Co je ověřené a co ještě vyžaduje reálný test

Testy pokrývají klubové heslo, omezení pokusů, PKCE, vazbu návratu na konkrétní
prohlížeč, jednorázové a časově omezené přihlášení, odmítnutí podvrženého
návratu a oddělení vlastnictví členů. Heslo není součástí návratové URL.
Discord access token se neukládá do databáze ani neposílá klientskému kódu.

Automatické testy používají testovacího poskytovatele. Skutečné přihlášení
na Discordu je potřeba jednou projít po doplnění konfigurace. Bez ní je
tlačítko přihlášení záměrně vypnuté. Přesné chování polí a oprávnění popisuje
[oficiální OAuth2 dokumentace](https://github.com/discord/discord-api-docs/blob/main/developers/topics/oauth2.mdx).

## Cloudflare

Pro veřejné nasazení použij [CLOUDFLARE_DEPLOYMENT.md](CLOUDFLARE_DEPLOYMENT.md).
Discord musí mít povolenou i přesnou HTTPS callback adresu veřejné aplikace;
Cloudflare tajemství jsou oddělená od lokálního `.env`.

