# Studovna

Studijní apka: nahraješ zápisy (PDF, fotky sešitu, Word, text) a AI z nich udělá
výpisky, kartičky a cvičný test. V chatu „Zeptej se AI“ ti cokoliv vysvětlí od
základů a na požádání upraví výpisky, kartičky i test.

## Spuštění

```bash
npm install
cp .env.example .env    # doplň ANTHROPIC_API_KEY (a APP_PASSWORD)
npm start               # http://localhost:3000
```

Potřebuješ Node.js 20.12+ a API klíč z https://platform.claude.com.

## Co umí

- **Profily** – každý (ty, brácha) má své předměty a postup.
- **Předměty a témata** – ke každému tématu libovolně materiálů, volitelně datum testu.
- **Výpisky** – se zvýrazněním, tabulkami a vzorci (LaTeX). Označ text a zvýrazni ho,
  nech si ho vysvětlit nebo z něj udělej kartičku. Ruční úprava, tisk do PDF.
- **Kartičky** – opakování s odstupem (co umíš, vrací se za 1, 3, 7, 16… dní), klávesy
  mezerník / 1 / 2.
- **Test** – výběr z možností, pravda/nepravda i otevřené otázky (hodnotí AI),
  okamžité vysvětlení, historie výsledků, opakování jen chybných.
- **Zeptej se AI** – zná tvoje materiály i aktuální výpisky; umí je zkrátit, zvýraznit,
  přepsat, přidat/upravit/smazat kartičky a otázky.

## Nasazení na internet

Stačí jakýkoli hosting, kde běží Node nebo Docker **s trvalým diskem** (data jsou
v jednom souboru `DATA_DIR/db.json`). Nastav `ANTHROPIC_API_KEY`, `APP_PASSWORD`
a `DATA_DIR` na připojený disk.

```bash
docker build -t studovna .
docker run -p 3000:3000 -v studovna-data:/data \
  -e ANTHROPIC_API_KEY=... -e APP_PASSWORD=... studovna
```

## Struktura

- `server/index.js` – HTTP API, nahrávání, průběh zpracování
- `server/ai.js` – volání Claude: přepis, generování, chat s nástroji, hodnocení
- `server/store.js` – úložiště (JSON soubor)
- `public/` – frontend bez build kroku (`app.js`, `styles.css`)
