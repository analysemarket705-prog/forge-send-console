# Forge Send Console — revue par lot + envoi espacé depuis le navigateur

Stage 4b de la pipeline Forge. Déployé sur **Vercel**, ce dossier devient une
console web où tu **valides ou rejettes les emails un par un depuis n'importe
quel navigateur** — puis tu **verrouilles le lot** d'une seule confirmation
tapée, et les envois SMTP partent du serveur Vercel **espacés de 5 à 10 min**,
calendrier tenu par un **workflow GitHub Actions** (pas d'onglet à garder
ouvert, pas de scheduler tiers). Rien ne s'envoie jamais sans le verrouillage
humain.

Ce dépôt est **public** : il ne contient **aucun secret** — pas de token
console (placeholder + procédure de rotation ci-dessous), pas de SMTP, pas de
KV. Les valeurs réelles vivent dans les Vercel Environment Variables et les
secrets GitHub. Le code déployé vient de
`/workspace/Forge-Contact/sendconsole/` (dossier Syncthing, hors git).

## Le flux de revue par lot

1. **Pousse** les drafts + mockups en file (`--send-push`) : chaque carte
   arrive avec la bio du prospect, l'email complet, la maquette, la checklist
   pré-vol. Chaque mockup part par **un `POST /api/image`** (une requête par
   image — un seul POST embarquant ~16 × 300 KB de base64 dépasserait le
   plafond de corps de fonction Vercel → 413), puis la file est poussée
   allégée (sans base64, `present: true`).
2. **Marque chaque carte** dans le navigateur :
   - `✓ Valider` → la carte partira au verrouillage ;
   - `✗ Rejeter` → le prospect ne sera jamais contacté (raison facultative,
     appliquée à tous les rejets au verrouillage) ;
   - `Modifier` → décris le changement en clair, une variante de l'agent
     writer (DeepSeek, côté serveur) réécrit sujet + corps ; règles maison
     appliquées côté serveur (`[Partnership] `, sign-off Forge). Le texte
     révisé est ce qui partira.
   Les marques ne font **rien** tant que le lot n'est pas verrouillé — tu
   peux les retirer (`↺ réinitialiser la revue`) sans conséquence.
3. **Verrouille le lot** : la modale liste exactement les N destinataires
   (adresse + sujet + « immédiat » / « 5-10 min après le précédent »). Tu
   tapes **`ENVOYER N`** — c'est LA confirmation humaine unique pour tout le
   lot, vérifiée **côté serveur**. Au verrouillage :
   - les rejets marqués deviennent des décisions `rejected_manual` ;
   - chaque approbation est **gelée** dans un enregistrement de lot
     (`forge:batch` : texte exact, adresse, pièce jointe) — un push ou une
     édition ultérieure ne peut plus changer ce qui part ;
   - le lot est prêt : **le premier email part au prochain tick du cron**,
     puis un email par tick. L'intervalle visé entre deux envois est 5-10 min —
     dans la pratique, GitHub Actions exécute les runs programmés de façon
     **best-effort** : sur un dépôt peu actif, des écarts de plusieurs heures
     entre ticks ont été observés (4h30). Le lot se vide donc au rythme des
     ticks réels, jamais en rafale (un tick = un email au plus) ; pour
     envoyer tout de suite sans attendre le tick suivant : bouton
     « Run workflow » sur GitHub ou `gh workflow run send-due.yml`.
4. **Laisse tourner** : le cron GitHub Actions (toutes les 5 min —
   exécution best-effort, cf. *Le calendrier* ci-dessous) appelle
   `/api/senddue`, qui relaie **au plus un** email `queued` par tick vers
   `/api/batchsend` (SMTP sur Vercel), lequel enregistre la décision `sent`
   (`via: batch`). Tu peux fermer le navigateur. La console affiche la
   progression (`Lot en cours — 2/5 envoyés · prochain envoi vers 14:05`).
   Un tick manqué est rattrapé au tick suivant (auto-réparation) ; un double
   tick est inoffensif (chaque envoi est protégé par un claim). Un envoi qui
   échoue en SMTP est retenté par les ticks suivants jusqu'à
   `FORGE_BATCH_MAX_TRIES` (défaut 3) puis **dead-letté** (cf. *Dead-letter
   SMTP* ci-dessous) — le lot continue, une adresse en échec permanent ne le
   gèle plus jamais. Pour faire partir un email **immédiatement** sans
   attendre le prochain tick : bouton « Run workflow » sur GitHub, ou
   `gh workflow run send-due.yml` (dépôt
   `analysemarket705-prog/forge-send-console`) — à relancer par email à
   envoyer si les ticks tardent.
5. **Récupère les décisions** quand le lot est terminé (`--send-pull`) : les
   mds portent `status: sent` (`sent_at`, texte exact envoyé — syncé dans la
   section `## Email draft` si l'email avait été modifié),
   `rejected_manual` (raison dans `error`) ou `send_failed` (dead-letter
   SMTP — jamais livré), et la console est vidée. En direct, chaque carte
   quitte la revue dès sa décision : pendant la livraison les cartes
   envoyées n'ont plus que la barre de progression du lot, et l'onglet
   **Terminés** garde la liste (sujet + adresse tant que les décisions ne
   sont pas rapatriées, lignes KPI ensuite).

## Workflow (une fois déployé)

```bash
# 1. Sur la machine qui a les drafts (celle-ci) — met les drafts + mockups en file :
python run_forge_outreach.py --send-push

# 2. N'importe où : ouvre l'URL Vercel dans un navigateur, saisis le token,
#    marque chaque carte ✓ / ✗ (Modifier si besoin), puis verrouille en
#    tapant ENVOYER N. Les envois partent du serveur, un par tick de 5 min.
#    (Optionnel : gh workflow run send-due.yml pour envoyer le premier tout
#    de suite au lieu d'attendre le prochain tick.)

# 3. Reviens ici une fois le lot terminé (ou plus tard — le cron n'attend pas) :
python run_forge_outreach.py --send-pull
```

Détails utiles :

- `--send-push --dry-run` / `--send-pull --dry-run` : aperçu sans rien faire.
- `--send-pull` **refuse** d'effacer une décision qu'il n'a pas enregistrée
  (un verdict sent/rejected ne peut pas se perdre entre la console et les mds)
  et **refuse tant qu'un lot n'a pas fini de livrer** (ses images doivent
  rester dans le KV pour les pièces jointes programmées) — il affiche alors
  les envois restants et leur heure.
- `--send-push` **refuse** de pousser tant que des décisions ne sont pas
  récupérées **ou** qu'une revue (marques) / un lot est en cours.
- Après le pull, les mds portent `status: sent` (`sent_at` renseigné — jamais
  re-queue), `rejected_manual` (raison dans `error`) ou `send_failed`
  (dead-letter SMTP, cf. ci-dessous). Le `outreach/contact_ledger.csv` est
  régénéré automatiquement : le verdict reste enregistré même si un md est
  supprimé — **sauf `send_failed`, volontairement non terminal** : rien n'a
  jamais été reçu, si le md disparaît la personne redevient contactable.
- **Le md = ce qui est réellement parti.** La décision `sent` enregistre le
  texte exact (sujet + corps) ; si l'email a été modifié sur la console, le
  pull réécrit la section `## Email draft` du md avec ce texte avant
  d'enregistrer la décision.
- **Modifier = règles maison appliquées côté serveur** (`api/revise.js`) : le
  sujet recommence par `[Partnership] ` et le corps se termine par
  `-Ronan Delerue` + `Forge — https://forgefitapp.co/` — comme
  `ensure_house_rules` côté writer local. Une révision est marquée sur la
  carte (`✏️ modifié`) et gelée telle quelle dans le lot au verrouillage.
  Le SYSTEM du Modifier reflète aussi l'offre 30/70 du writer (`agents/
  email_contact_writer.py` `FORGE_OFFER`) : sans investissement initial (ni
  frais mensuels, rien tant que l'app ne gagne rien), Forge prend 30 % des
  revenus de l'app, le créateur garde 70 % — si une réécriture touche à
  l'argent, elle doit citer ces chiffres explicites. Le SYSTEM interdit
  aussi les statistiques (open rates push, revenus affiliés) et les claims
  non étayées sur Instagram, l'email ou la plateforme actuelle du créateur,
  proscrit le ton combatif envers cette plateforme, et impose la narration
  partenariat (découverte Instagram → valeur pour les followers →
  réputation → monétisation) quand l'instruction vise le récit.
  (Deux sources vivantes pour la même phrase d'offre — les garder synchro.)
- La console terminale (`python run_forge_outreach.py --send`) reste
  disponible — c'est l'autre chemin d'envoi, avec confirmation par adresse
  tapée par email. Le lot web et la console terminale partagent le même
  format de décision dans les mds.

## Dead-letter SMTP (`send_failed`)

Un email du lot qui échoue en SMTP est retenté par les ticks suivants (rien
n'est enregistré, réponse 502, réessai naturel). Chaque tentative incrémente
`tries` ; au plafond `FORGE_BATCH_MAX_TRIES` (env Vercel, défaut 3 — la
dead-letter tombe au 3e tick d'échec : ~15-30 min quand les ticks arrivent
toutes les 5-10 min, plus longtemps quand GitHub tarde — mais toujours
bornée, jamais infinie), l'item est
**dead-letté dans le même verrou que la relecture** : décision
`{action: "failed", tries, detail}` — volontairement **sans sujet, corps ni
tk** (rien n'est parti : rien à synchroniser, rien à tracker) — statut de
l'item `failed`, réponse 200 (le tick ne logue pas d'erreur). Le lot continue
au tick suivant : une adresse en échec permanent ne peut plus geler tout le
lot ni la console (lock/clear/push redeviennent possibles une fois les
décisions rapatriées).

`--send-pull` écrit `status: send_failed` dans le md (l'en-tête du record dit
« SMTP send FAILED — email NOT sent to … » ; le champ `error` garde
« SMTP send failed after N attempts on the web console (batch): … ») — le
prospect n'est **pas** scellé au ledger (verdict machine, pas un « ne jamais
contacter » humain) : corrige l'adresse dans le md, puis re-tente via la
console terminale (`--send --include-rejected`).

Sans tracking par conception : `failed` viole l'invariant « décision ⇒
tracking » — tous les consommateurs sont gatés sur l'événement `sent` (le
heal ne converge vers `sent` que depuis une décision `action: sent`, les KPIs
ne plient que les envois réels). Une décision `failed` n'apparaît jamais dans
l'onglet KPIs ; dans l'onglet **Terminés**, elle porte le badge
« ✗ ÉCHEC SMTP — N essais ».

## Le calendrier : GitHub Actions (`forge-send-due`)

`.github/workflows/send-due.yml` — expression `2-59/5 * * * *` (toutes les
5 min), et à la demande via le bouton « Run workflow ». Le workflow ne fait
**qu'un appel HTTP** : `POST $FORGE_CONSOLE_URL/api/senddue` avec le token
console. Côté serveur, `senddue` lit le lot verrouillé dans le KV et envoie
**un seul** email `queued` au plus (le plus ancien) à `/api/batchsend`, qui
fait le SMTP.

**Fiabilité observée — lire avant de verrouiller un lot pressé** : GitHub
exécute les workflows programmés de façon best-effort, et sur un dépôt à
faible activité les ticks sont souvent très espacés (constaté : 2 runs en
8h30, écart de 4h30 — au lieu des ~96 attendus). Un lot verrouillé n'est
**pas** garanti de s'écouler à 5-10 min ; il s'écoule au rythme des ticks
réels (au plus un email par tick). Le lot d'aujourd'hui est donc aussi
actionnable à la main : `gh workflow run send-due.yml` après le lock fait
partir le premier email immédiatement, et une relance par email restant
maintient la cadence voulue. Chaque tick est idempotent (un seul email, un
claim `SET NX` par prospect) — dispatcher plusieurs fois est inoffensif, ça
ne fait jamais partir deux emails au même tick. Si le rythme 5-10 min devient
un besoin ferme, le remplaçant naturel est un scheduler du côté serveur
(QStash à token valide, ou Vercel Cron en plan Pro) — `senddue` reste le
relais commun quel que soit le ticker.

Les seuls réglages du dépôt GitHub :

| Réglage | Type | Valeur |
|---|---|---|
| `FORGE_CONSOLE_URL` | **variable** | `https://forge-send-console.vercel.app` |
| `FORGE_CONSOLE_TOKEN` | **secret** | identique au secret Vercel du même nom |

Les identifiants SMTP ne quittent jamais les Vercel secrets — le workflow
n'en a pas besoin.

## Suivi des emails (pixel + clic) et onglet KPIs

Chaque email d'un lot verrouillé part **tracké** : au moment de l'envoi,
`batchsend` tire un `tk` frais (`crypto.randomBytes(12)` → 24 hex) et
construit le message final — c'est la seule mutation du texte gelé, après le
lock :

- le corps texte voit l'URL de signature réécrite mécaniquement :
  `https://forgefitapp.co/` → `{trackBase}/api/r?tk=<tk>` — **ces octets-là
  sont ce que SMTP envoie ET ce que la décision enregistre** (le md reste
  fidèle à ce qui est parti) ;
- une partie HTML miroir (texte échappé + pixel `{trackBase}/api/pix?tk=<tk>`
  de 1×1) est jointe en `multipart/alternative` — le rendu visible est
  identique, et un client qui charge les images ouvre le pixel.

`trackBase` = l'env `FORGE_TRACK_BASE` (défaut `https://go.forgefitapp.co`).
Réécriture et pixel vivent dans `_lib.js` (`rewriteText`/`htmlMirror`) ;
l'agent writer local et le chemin terminal (`--send`, console locale) ne sont
**pas** trackés.

**Événements (KV — clés qui survivent au `--send-pull` par conception)** :
`forge:tkmap:<tk>` = `{username, sentAt}` (TTL 90 j) ; `forge:trk:<username>`
= historique `{kind: sent|open|click|reply, tk, at, outcome?}` (100 max) ;
`forge:trkusers` = les prospects trackés. Le `sent` est écrit dans le **même**
pipeline que la décision (la décision en dernier — si elle existe, le
tracking existe). **Jamais d'IP ni d'User-Agent stockés.** Un crash entre le
SMTP et le pipeline est réparé par le heal idempotent du chemin
prior-decision (le `tk` est relu dans le corps de la décision) — le heal ne
converge vers `sent` que si la décision relue est bien `action: sent` ; une
décision `failed` (pas de tk) laisse l'item sur `failed` (cf. *Dead-letter
SMTP*).

**Endpoints** :

| Endpoint | Auth | Rôle |
|---|---|---|
| `GET /api/pix?tk=…` | **aucune** | pixel d'ouverture : 200 `image/gif` 42 octets toujours (tk mort inclus) + événement `open` si le tk est connu |
| `GET /api/r?tk=…` | **aucune** | clic : 302 vers le site toujours (tk mort inclus) + événement `click` si connu |
| `GET /api/kpi` | token | agrège opens/clics/réponses par prospect + totaux (voir l'onglet) |
| `POST /api/kpi` | token | **deux actions** — réponse : `{username, outcome: positive\|neutral\|negative\|bounce}` en **sémantique de remplacement** (re-marquer ne double jamais) ; `outcome` vide **retire** la marque. Auto-test : `{username, clearSelf: true}` (voir « C'était moi » ci-dessous) |

Le marquage de réponse est un `POST` sur `/api/kpi` (et non une route séparée)
parce que le plan Hobby plafonne les fonctions serverless à 12 par
déploiement — chaque fichier de `api/` est une fonction (les fichiers sans
`export default`, comme `_lib.js`, ne comptent pas). Tout nouvel endpoint se
fusionne dans un fichier existant ; la route d'envoi immédiat `POST /api/decide`
(ancienne console) a été supprimée dans la même passe — 404.

**Onglet KPIs** (header de la console) : totaux (envoyés, ouverts — comptés
« ≥ 1 ouverture + délai de première ouverture » —, clics, réponses par issue)
et une ligne par prospect tracké avec le sélecteur de réponse. Les données
commencent au déploiement : les envois d'avant (premier lot, console locale)
n'ont pas de tracking.

**Onglet Terminés** (Terminés / Historique dans le code) : la trace des
cartes qui ont quitté la revue. Tant que des décisions ne sont pas
rapatriées, il liste les décisions du dernier lot — prospect, action
(`✓ ENVOYÉ` / `✗ rejeté` / `✗ ÉCHEC SMTP — N essais`), quand, vers quelle
adresse, sujet (badge « ✏️ modifié » si l'email avait été révisé),
détail/raison. Après `--send-pull`, les décisions sont vidées et l'onglet
retombe sur les lignes KPI (prospect | envoyé | ouverture | clics | réponse)
— le tracking ne stocke ni sujet ni adresse par conception, ils
disparaissent donc au retour local (limite honnête, rappelée dans
l'onglet). Les envois faits depuis la console terminale (`--send`) n'y
apparaissent jamais : leur trace est le md `outreach/<username>.md`.

**« C'était moi »** — le pixel et le clic ne portent aucune identité (aucune
IP/UA stockée, par conception) : impossible de distinguer une ouverture du
prospect de celle du reviewer quand il vérifie l'email dans ses Envoyés Zoho
ou clique le lien pour tester. Le bouton **« C'était moi »** de la ligne d'un
prospect retire ses événements `open`/`click` des KPIs (`POST /api/kpi
{username, clearSelf: true}`) — l'envoi reste compté, les réponses marquées
restent, le fold est recalculé (totaux inclus). Nettoyage explicite : le
reviewer sait ce qu'il a touché ; idempotent (rien à retirer → `removed: 0`),
404 si le prospect n'a pas d'envoi tracké.

**Limites honnêtes** : Gmail/Outlook préchargent les images via leurs proxys —
une ouverture proxy n'est pas un humain, les chiffres d'ouverture sont
approximatifs (le clic, lui, n'a pas ce problème) ; un client qui ne rend que
le texte ne charge jamais le pixel (rare — la partie HTML gagne dans les
clients modernes).

### Le domaine `go.forgefitapp.co`

Le tracking a besoin d'un domaine dédié (un lien de clic raccourci propre) :

```bash
# Dashboard Vercel -> projet forge-send-console -> Settings -> Domains -> add
# go.forgefitapp.co -> instruction DNS fournie (CNAME go -> cname.vercel-dns.com)
# à poser chez le provider DNS de forgefitapp.co. Apex vérifié du projet : le
# déploiement des endpoints n'exige PAS le domaine (fallback : les liens
# pointent vers l'origin .vercel.app tant que le CNAME n'est pas posé — plus
# laid, mais fonctionnel).
```

## Déploiement

### 1. Projet Vercel + KV Upstash

```bash
cd /workspace/Forge-Contact/sendconsole
vercel login          # navigateur : connecte ton compte
vercel link           # crée le projet (ex. forge-send-console) — dossier local sendconsole
```

Côté dashboard <https://vercel.com> :
**Storage → Create → Upstash KV** (plan gratuit suffit : 1 redis, le volume
d'une file de drafts est minuscule). Dans le KV créé, onglet **REST API** :
note `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.

### 2. Environment Variables (dashboard → projet → Settings → Environment Variables)

| Nom | Valeur |
|---|---|
| `FORGE_SMTP_HOST` | `smtp.zoho.com` |
| `FORGE_SMTP_PORT` | `587` |
| `FORGE_SMTP_USER` | `ronan.delerue@forgefitapp.co` |
| `FORGE_SMTP_PASS` | le mot de passe Zoho (cf. `.env` local) |
| `FORGE_EMAIL_FROM` | `ronan.delerue@forgefitapp.co` |
| `FORGE_EMAIL_FROM_NAME` | `Ronan Delerue` |
| `FORGE_KV_REST_URL` | l'URL REST du KV Upstash |
| `FORGE_KV_REST_TOKEN` | le token REST du KV Upstash |
| `FORGE_CONSOLE_TOKEN` | `<à générer>` — **identique** au secret GitHub et au `FORGE_CONSOLE_TOKEN` du `.env` local ; le navigateur le demande une fois par navigateur (retenu en `localStorage` — même jeton, jamais retapé) |
| `DEEPSEEK_API_KEY` | la clé DeepSeek du `.env` local — nécessaire au bouton **Modifier** (`api/revise.js` appelle l'agent writer depuis le serveur). Sans elle : 500 « modifier cannot run ». Modèles/endpoint surchargeables via `FORGE_REVISE_MODEL` / `FORGE_REVISE_BASE` |
| `FORGE_TRACK_BASE` | `https://go.forgefitapp.co` — l'origine des liens de tracking réécrits dans chaque email (pixel + clic). Surchargeable pour un test local ; sans elle, les liens pointent vers `go.forgefitapp.co` par défaut |
| `FORGE_BATCH_MAX_TRIES` | (optionnel, défaut `3`) — essais SMTP maximum par item avant dead-letter `failed`. Plus bas = lot plus réactif ; plus haut = plus tolérant aux pannes SMTP brèves |

Cocher **Production** (et Preview si tu veux tester sur les URLs de preview).
Valeurs réelles du SMTP : uniquement dans les secrets Vercel + le `.env`
local — le code de `sendconsole/` n'en contient aucune.

### 3. Ce dépôt GitHub (public) + le workflow

```bash
cd /workspace/Forge-Contact/sendconsole   # seul sous-dossier versionné (pas de git à la racine Forge-Contact)
git init && git add -A && git commit -m "Forge send console — batch review + GitHub-scheduled sends"
gh repo create forge-send-console --public --source . --push
gh variable set FORGE_CONSOLE_URL --repo analysemarket705-prog/forge-send-console \
  --body https://forge-send-console.vercel.app
gh secret set FORGE_CONSOLE_TOKEN --repo analysemarket705-prog/forge-send-console
```

Le cron tourne sur la branche par défaut ; le fichier
`.github/workflows/send-due.yml` est lu au push. Premier tick programmé dans
les 5 min suivantes.

### 4. Déployer + pointer le CLI local

```bash
vercel deploy --prod
```

Puis, dans `/workspace/Forge-Contact/.env`, renseigne :

```
FORGE_CONSOLE_URL=https://forge-send-console.vercel.app
FORGE_CONSOLE_TOKEN=<le même token que le secret Vercel>
```

### 5. Vérifier (sans envoyer pour de vrai)

```bash
python run_forge_outreach.py --send-push --dry-run   # liste ce qui partirait
python run_forge_outreach.py --send-push             # pousse les drafts en attente
# ouvre l'URL : token -> cartes -> mockups présents ?
# marque 1 carte ✓, ouvre le verrouillage : la modale liste le destinataire ;
# ferme la modale et fais ↺ réinitialiser la revue (rien n'a été envoyé).
python run_forge_outreach.py --send-pull             # no-op (aucune décision)
```

Smoke de la revue vivante et de l'historique (rien ne part, aucune carte
marquée n'est verrouillée) :

- marque 2 cartes puis **↺ réinitialiser la revue** : les marques disparaissent
  et l'onglet Réseau du navigateur montre **un seul** appel
  `POST /api/stage {"reset": true}` (le reset est atomique côté serveur — pas
  un reset par carte) ;
- l'onglet **Terminés** retombe sur les lignes KPI tant qu'aucune décision
  n'existe (« Aucun envoi suivi » avant le premier lot verrouillé), puis
  n'évolue qu'avec de vraies décisions (envoyé/rejeté) — le cas
  « ✗ ÉCHEC SMTP » se voit en conditions réelles quand une adresse échoue
  après `FORGE_BATCH_MAX_TRIES` ;
- laisse la page ouverte 30 s sans rien toucher : le poll ne doit pas bouger
  le scroll ni faire re-télécharger les mockups (onglet Réseau : un seul
  `GET /api/image` par carte sur plusieurs polls — c'est le cache par
  username) ;
- pendant la livraison d'un lot réel, les cartes envoyées quittent la revue
  en direct (elles ne réapparaissent qu'en Terminés), et les cartes non
  marquées n'offrent plus d'actions — elles reviennent au round suivant
  après `--send-pull`.

Un envoi réel ne part qu'après un verrouillage `ENVOYER N` tapé à la main,
puis un tick du cron (ou `gh workflow run send-due.yml` pour le premier
email immédiatement). Pour un test d'envoi complet sans destinataire réel :
marque une carte d'un brouillon avec une adresse `@example.com` *dans le md*
(jamais l'inverse), verrouille, et vérifie le `sent_at` dans le md après le
pull — puis remets l'adresse réelle.

## Sécurité

- **Dépôt public, zéro secret dedans.** Le token console n'apparaît nulle
  part dans le code (placeholder dans ce README) ; la seule trace locale est
  le `.env` (hors git). Rotation du token console (après une exposition
  possible, ou simplement par hygiène) :
  1. génère un nouveau hex, par ex. `openssl rand -hex 24` ;
  2. remplace le secret Vercel `FORGE_CONSOLE_TOKEN` (dashboard → projet →
     Settings → Environment Variables) et redéploie ;
  3. remplace le secret GitHub du même nom (`gh secret set
     FORGE_CONSOLE_TOKEN --repo analysemarket705-prog/forge-send-console`) ;
  4. remplace la valeur dans `/workspace/Forge-Contact/.env`.
- **`FORGE_CONSOLE_TOKEN`** : l'accès à la page et à tous les endpoints API
  exige `x-forge-token` / la saisie du token. Sans lui : 401. Si le serveur
  n'a pas la variable configurée : 500 (un secret manquant ne devient jamais
  une console vide/ouverte). `/api/senddue` exige le même token — le secret
  GitHub est la seule voie d'appel du cron.
- **Confirmation `ENVOYER N` tapée, vérifiée côté serveur** : le client ne
  dit jamais au serveur « je suis confirmé » — le serveur compare lui-même la
  phrase (majuscules/espaces ignorés) au nombre de validations verrouillées.
  Un verrouillage au mauvais nombre ou à la mauvaise phrase répond 400.
- **Une décision par prospect, un lot à la fois** : un prospect déjà décidé,
  marqué, ou verrouillé dans un lot actif répond 409 à `stage`/`revise`/
  un nouveau `lock` (l'ancienne route `/api/decide` n'existe plus — 404) —
  un double envoi est impossible même avec deux onglets ouverts (le serveur
  garde l'historique).
- **Le lot gèle le texte** : l'envoi lit le snapshot du lot, plus jamais la
  file — un `--send-push` concurrent ne peut pas changer ce qui a été
  verrouillé.
- **Envoi sans double, sans perte** : `/api/batchsend` n'est joignable que
  par `/api/senddue` (donc par le cron) avec le secret du lot ; un claim
  `SET NX` par prospect dédoublonne les ticks qui se chevauchent, et la
  décision `sent` est enregistrée **avant** la mise à jour du statut (un
  crash entre les deux est réparé par le tick suivant). SMTP en échec :
  sous `FORGE_BATCH_MAX_TRIES`, rien d'enregistré + réponse 502 → le tick
  suivant réessaie ; au plafond, **dead-letter** dans le même verrou
  (décision `failed` sans texte ni tk + statut `failed` + réponse 200) → le
  lot continue (cf. *Dead-letter SMTP*).
- **Secrets côté serveur uniquement** : le binaire client n'a jamais vu le
  mot de passe SMTP ; la b64 du mockup est stockée au moment du push dans le
  KV et supprimée au pull (le pull refuse de vider la console tant que le
  lot n'a pas fini de livrer).
- **`pix`/`r` volontairement publics, jamais de données personnelles** : un
  client mail ne peut pas envoyer `x-forge-token`, donc l'auth de ces deux
  endpoints est le `tk` lui-même — 24 hex aléatoires par envoi, inestimables
  par un tiers (et morts au bout de 90 j). Aucune requête ne stocke d'IP ni
  d'User-Agent ; un `tk` inconnu reçoit le même 200/302 qu'un bon (aucun
  oracle). Seul `/api/kpi` (GET et POST) est sous token — les réponses ne
  peuvent être marquées que par quelqu'un qui a le token console.
- **Le md ≠ lien de tracking** : la réécriture mécanique (URL de signature →
  tracker) n'est pas une édition humaine. Un envoi non modifié garde dans son
  md le texte approuvé, sans lien console ; un envoi révisé voit sa section
  draft synchronisée aux **octets envoyés** (lien tracker inclus) par le
  pull. Les octets exacts de chaque envoi vivent aussi dans les événements KV
  (`forge:trk:*`), qui survivent au pull.
