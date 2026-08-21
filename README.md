# google-tasks-mcp

Ein Remote-MCP-Server, der Google Tasks als Custom Connector in Claude.ai
verfügbar macht. Läuft auf Cloudflare Workers, erreichbar über Streamable
HTTP, und ist auf **genau einen** Google-Account beschränkt.

## Werkzeuge

| Tool | Parameter | Annotations |
|---|---|---|
| `list_tasklists` | – | `readOnlyHint` |
| `list_tasks` | `tasklist_id`, `show_completed`, `due_after`, `due_before` | `readOnlyHint` |
| `create_task` | `title`, `notes`, `due`, `tasklist_id` | – |
| `update_task` | `task_id`, `tasklist_id`, `title`, `notes`, `due`, `status` | `idempotentHint` |
| `complete_task` | `task_id`, `tasklist_id` | `idempotentHint` |
| `delete_task` | `task_id`, `tasklist_id` | **`destructiveHint`** |

Datumsangaben sind immer `YYYY-MM-DD`; Google Tasks speichert ohnehin nur das
Datum, nicht die Uhrzeit. `tasklist_id` ist überall optional und fällt auf die
Standardliste des Accounts zurück.

## Architektur

Zwei Auth-Ebenen, die sich keinen Token teilen:

```
                 Ebene 1: MCP-Auth-Spec              Ebene 2: Google OAuth
Claude.ai  ──────────────────────────────►  Worker  ──────────────────────►  Google
           /authorize /token /register              /oauth/google/callback
           PKCE S256, Bearer-Token                  Refresh-Token in KV (AES-GCM)
```

* **Claude → Worker**: Der Worker ist sein eigener OAuth-2.1-Server. Dynamic
  Client Registration, PKCE S256 (kein `plain`), Token-Endpoint nimmt
  `application/x-www-form-urlencoded`. Die Tokens sind HMAC-signierte,
  selbstverifizierende Strings — kein KV-Lesezugriff im Login-Pfad, weil KV
  nur *eventually consistent* ist und der Code-Tausch sonst sporadisch
  fehlschlagen würde.
* **Worker → Google**: Klassischer Authorization-Code-Flow mit
  `access_type=offline`. Der Refresh-Token liegt AES-GCM-verschlüsselt in KV,
  der Access-Token nur im Speicher. Bei `401` refresht der Client genau einmal
  und wiederholt den Aufruf genau einmal.

Der MCP-Endpoint spricht **beide Protokoll-Generationen**: die aktuelle
Revision `2026-07-28` (Per-Request-`_meta`, `server/discover`, gespiegelte
HTTP-Header) und die ältere `initialize`-basierte Form (`2025-11-25`,
`2025-06-18`, `2025-03-26`). Welche Revision Claude.ai verwendet, ist nicht
dokumentiert; die Spec erlaubt ausdrücklich, beide auf demselben Endpoint zu
bedienen.

## Voraussetzungen

* Node.js 20+
* Ein Cloudflare-Account (der kostenlose Plan reicht — keine Durable Objects)
* Ein Google-Account
* `openssl` für die Schlüsselerzeugung

---

# Einrichtung

Die Schritte bauen aufeinander auf. Die Reihenfolge ist wichtig: Du brauchst
die Worker-URL, bevor Du den Google-OAuth-Client konfigurieren kannst.

## Schritt 1 — Abhängigkeiten installieren

```bash
npm install
```

## Schritt 2 — Bei Cloudflare anmelden und KV anlegen

```bash
npx wrangler login
npx wrangler kv namespace create TASKS_KV
```

Der zweite Befehl gibt eine ID aus. Trage sie in `wrangler.toml` ein und
ersetze damit `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`:

```toml
[[kv_namespaces]]
binding = "TASKS_KV"
id = "0123456789abcdef0123456789abcdef"
```

## Schritt 3 — Einmal deployen, um die URL zu bekommen

```bash
npx wrangler deploy
```

Am Ende steht die öffentliche Adresse, etwa:

```
https://google-tasks-mcp.<dein-subdomain>.workers.dev
```

Diese URL brauchst Du gleich mehrfach — im Folgenden `$WORKER`. Der Server
antwortet jetzt noch mit `500`, weil die Secrets fehlen. Das ist korrekt: er
startet nicht mit unvollständiger Konfiguration.

## Schritt 4 — Google-Cloud-Projekt und OAuth-Client

1. [console.cloud.google.com](https://console.cloud.google.com) öffnen und
   oben links ein **neues Projekt** anlegen, z. B. `tasks-mcp`.
2. **APIs & Services → Bibliothek** → nach *Google Tasks API* suchen →
   **Aktivieren**.
3. **Google Auth Platform** (früher *OAuth-Zustimmungsbildschirm*) öffnen und
   die Konfiguration starten:
   * *User Type* / Zielgruppe: **Extern** (bei einem privaten Google-Konto ist
     das die einzige Option).
   * App-Name und Support-E-Mail: Deine eigene Adresse.
   * Unter **Zielgruppe** Dich selbst als **Testnutzer** eintragen.
4. **Datenzugriff → Bereiche hinzufügen** → den Scope
   `https://www.googleapis.com/auth/tasks` auswählen und speichern.
5. **Clients → Client erstellen**:
   * Anwendungstyp: **Webanwendung**
   * Autorisierte Weiterleitungs-URIs — beide eintragen:
     * `$WORKER/oauth/google/callback`
     * `http://localhost:8787/oauth/google/callback` *(nur nötig, wenn Du
       lokal testen willst — siehe unten)*
6. Client-ID und Client-Secret notieren.

### Wichtig: Veröffentlichungsstatus auf „In Produktion" setzen

Solange die App im Status **Testen** steht, laufen Google-Refresh-Tokens nach
**7 Tagen** ab, und Du müsstest den Connector wöchentlich neu verbinden. Stell
den Status unter **Google Auth Platform → Zielgruppe** auf **In Produktion**.

Weil `.../auth/tasks` ein sensibler Scope ist, zeigt Google beim Verbinden
einen Warnhinweis („Google hat diese App nicht überprüft"). Da Du der einzige
Nutzer bist, klickst Du dort auf **Erweitert → Weiter zu …**. Eine
Verifizierung ist für den Eigengebrauch nicht erforderlich.

## Schritt 5 — Deine eigene Google-Account-ID ermitteln

Die Allowlist prüft den `sub`-Claim Deines Google-Kontos. Den kann man nirgends
nachschlagen — der Server sagt ihn Dir deshalb selbst. Setze dafür einmalig den
Platzhalter:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID       # aus Schritt 4
npx wrangler secret put GOOGLE_CLIENT_SECRET   # aus Schritt 4
npx wrangler secret put TOKEN_SIGNING_KEY      # openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEY         # openssl rand -base64 32
npx wrangler secret put ALLOWED_GOOGLE_SUB     # genau: SETUP
```

Zwei zufällige Schlüssel erzeugst Du mit:

```bash
openssl rand -base64 32
```

Jetzt im Browser aufrufen:

```
$WORKER/authorize?response_type=code&client_id=setup&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256
```

Nach der Google-Anmeldung zeigt der Server eine Textseite mit Deiner
Account-ID (21 Ziffern). Es wird dabei **nichts gespeichert** und kein Token
ausgegeben — im `SETUP`-Modus lehnt die Allowlist jeden ab.

Trag die ID dann als echten Wert ein:

```bash
npx wrangler secret put ALLOWED_GOOGLE_SUB     # die 21-stellige Zahl
```

## Schritt 6 — Secrets prüfen

```bash
npx wrangler secret list
```

Es müssen fünf Einträge da sein: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`ALLOWED_GOOGLE_SUB`, `TOKEN_SIGNING_KEY`, `ENCRYPTION_KEY`.

Keiner davon steht in `wrangler.toml` oder im Repository. `.dev.vars` ist
über `.gitignore` ausgeschlossen.

## Schritt 7 — Deployen

```bash
npm run typecheck && npm test && npx wrangler deploy
```

Kurzer Funktionstest:

```bash
curl -s $WORKER/.well-known/oauth-protected-resource | jq
curl -si -X POST $WORKER/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -3
```

Der erste Aufruf muss das Metadaten-Dokument liefern, der zweite ein `401`
mit einem `WWW-Authenticate`-Header.

## Schritt 8 — Connector in Claude.ai einrichten

1. In Claude.ai auf **Einstellungen → Connectors** gehen.
2. **Connector hinzufügen** wählen.
3. Als URL eintragen:

   ```
   $WORKER/mcp
   ```

4. Claude registriert sich selbst, öffnet den Login und leitet Dich zu Google.
   Melde Dich mit **dem Konto an, dessen ID Du in Schritt 5 hinterlegt hast**.
   Klick den Unverifiziert-Hinweis mit **Erweitert → Weiter zu …** durch.
5. Nach der Zustimmung landest Du zurück in Claude.ai; der Connector ist
   verbunden.

Falls Du Dich versehentlich mit einem anderen Google-Konto anmeldest, bricht
der Vorgang mit `access_denied` ab — genau so ist es gedacht.

## Schritt 9 — Ausprobieren

Frag Claude im Chat etwa: *„Welche Aufgabenlisten habe ich?"* oder
*„Leg mir eine Aufgabe ‚Steuer machen' mit Fälligkeit 15.03. an."*

---

# Lokal testen

## wrangler dev

```bash
cp .dev.vars.example .dev.vars      # und mit echten Werten füllen
npx wrangler dev
```

Läuft auf `http://localhost:8787` mit einem lokalen KV-Emulator. Für den
OAuth-Durchlauf brauchst Du zusätzlich:

* in `wrangler.toml`: `ALLOW_LOCAL_REDIRECT = "true"` (erlaubt die
  Loopback-Redirect-URI des Inspectors)
* in Google Cloud: `http://localhost:8787/oauth/google/callback` als
  autorisierte Weiterleitungs-URI (siehe Schritt 4)

`SERVER_BASE_URL` bleibt leer, dann leitet der Worker seine Basis-URL aus der
eingehenden Anfrage ab.

> Beide Lockerungen gehören **nicht** in die Produktion. Setz
> `ALLOW_LOCAL_REDIRECT` vor dem nächsten `wrangler deploy` wieder auf
> `"false"`.

## MCP Inspector

In einem zweiten Terminal:

```bash
npx @modelcontextprotocol/inspector
```

Der Inspector öffnet sich auf `http://localhost:6274`. Dort einstellen:

* **Transport Type**: `Streamable HTTP`
* **URL**: `http://localhost:8787/mcp`

Dann **Connect**. Der Inspector findet über
`/.well-known/oauth-protected-resource` den Authorization-Server, registriert
sich per DCR, schickt Dich durch den Google-Login und kommt mit einem Token
zurück. Danach kannst Du unter **Tools** `tools/list` aufrufen und jedes Tool
einzeln mit eigenen Argumenten testen.

Ohne kompletten OAuth-Durchlauf geht es auch: Wenn Du schon einen
Access-Token hast, kannst Du direkt mit `curl` sprechen.

```bash
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

---

# Betrieb

**Zugriff sofort entziehen** — eine der beiden Maßnahmen genügt:

```bash
# 1. Alle von uns ausgegebenen Tokens ungültig machen
npx wrangler secret put TOKEN_SIGNING_KEY     # neuen Wert setzen

# 2. Den gespeicherten Google-Refresh-Token löschen
npx wrangler kv key delete "google:refresh_token" --binding TASKS_KV --remote
```

Zusätzlich lässt sich der Zugriff jederzeit unter
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
auf Google-Seite widerrufen.

**Logs ansehen:**

```bash
npx wrangler tail
```

Geloggt werden nur Methode, Pfad, Statuscode und Dauer. Keine Tokens, keine
Query-Strings (die enthalten Codes und State), keine Aufgabeninhalte.

---

# Sicherheitsmodell

Was aktiv geschützt ist:

* **Account-Allowlist.** Der `sub`-Claim wird an drei Stellen geprüft: beim
  Google-Callback (vorher wird nichts gespeichert), beim Einlösen des
  Authorization-Codes und bei jedem einzelnen Bearer-Token.
* **Redirect-URI-Allowlist.** Exakter String-Vergleich, keine Präfixe, keine
  Wildcards. Eine unbekannte Redirect-URI führt zu einer 400-Seite statt zu
  einem Redirect — sonst wäre der Server ein Open Redirector.
* **PKCE S256 verpflichtend.** `plain` wird nicht angeboten und nicht
  akzeptiert.
* **Audience-Bindung.** Ein Token, das für eine andere Resource ausgestellt
  wurde, wird abgelehnt (RFC 8707).
* **Refresh-Token verschlüsselt.** AES-GCM, Schlüssel aus
  `wrangler secret`. Im KV steht nur Ciphertext.
* **Rate-Limit pro Session.** 60 Aufrufe, davon 20 schreibende und 5
  Löschungen pro Minute. Das ist eine Bremse gegen ein Modell in einer
  Schleife, kein Schutz gegen einen Angreifer.
* **Keine Stacktraces nach außen.** Alle Antworten laufen über eine einzige
  Stelle, die unbekannte Fehler auf eine feste Meldung reduziert.

Bewusste Grenzen — nachlesbar im Code, hier zusammengefasst:

* **Refresh-Tokens sind nicht widerrufbar.** Sie sind zustandslos signiert;
  ein ausgegebener Token gilt bis zum Ablauf (30 Tage). Zum Abschalten
  `TOKEN_SIGNING_KEY` rotieren.
* **Einmaligkeit der Authorization-Codes ist best effort.** Der Marker liegt
  in KV, das über Rechenzentren hinweg *eventually consistent* ist. Ein Code
  lebt 60 Sekunden und ist an ein PKCE-Challenge gebunden; ein Replay bräuchte
  zusätzlich den Verifier.
* **Rate-Limit-Zähler ebenfalls in KV**, also aus demselben Grund näherungs-
  weise. Bei einem einzelnen Nutzer, dessen Anfragen im selben Rechenzentrum
  landen, stimmt es in der Praxis.
* **`id_token`-Signatur wird nicht geprüft.** Das Token kommt über TLS direkt
  aus Googles Token-Endpoint als Antwort auf unsere authentifizierte Anfrage —
  genau der Fall, den OpenID Connect Core 3.1.3.7 davon ausnimmt. Die Funktion
  darf auf keinem anderen Weg gefüttert werden.
* **Kein `Origin`-Blocking.** Der Endpoint authentifiziert ausschließlich per
  `Authorization`-Header, nie per Cookie. Fremdes Browser-JavaScript kann
  daher keine authentifizierte Anfrage im Namen des Nutzers stellen; ein
  Origin-Filter würde nur den Inspector aussperren.

---

# Projektstruktur

```
src/
  index.ts              Router und Fehler-Sammelstelle
  env.ts                Bindings, Konfigurationsprüfung
  errors.ts             McpError / ToolExecutionError / OAuthError
  crypto.ts             base64url, HMAC-Tokens, AES-GCM, timing-safe compare
  store.ts              KV-Zugriff
  http.ts               Response-Helfer, CORS
  ratelimit.ts          Zähler pro Session
  auth/
    mcp-oauth.ts        Ebene 1: Discovery, /authorize, /token, Bearer-Prüfung
    tokens.ts           signierte Codes und Tokens
    pkce.ts             S256
    clients.ts          DCR, Redirect-URI-Allowlist
    google.ts           Ebene 2: Google-OAuth, sub-Allowlist, Setup-Modus
  google/
    tasks-client.ts     Tasks API v1, 401 → Refresh → Retry
  mcp/
    server.ts           JSON-RPC, beide Protokoll-Generationen
    tools.ts            Tool-Definitionen und Annotations
    handlers.ts         Tool-Implementierungen
test/                   102 Unit-Tests
```

# Tests

```bash
npm test          # einmal
npm run test:watch
npm run typecheck
```

Die Google-API ist durchgehend gemockt, KV läuft in-memory. Abgedeckt sind
unter anderem Token-Refresh inklusive 401-Retry, die Allowlist an allen drei
Prüfpunkten, PKCE gegen den RFC-7636-Testvektor, der komplette OAuth-Durchlauf
über den Worker, beide Protokoll-Generationen samt Header-Validierung, die
Rate-Limits und die Tool-Handler.
