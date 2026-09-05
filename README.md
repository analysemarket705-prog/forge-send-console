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
   pré-vol.
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
   tick est inoffensif (chaque envoi est protégé par un claim). Pour faire
   partir un email **immédiatement** sans attendre le prochain tick : bouton
   « Run workflow » sur GitHub, ou `gh workflow run send-due.yml` (dépôt
   `analysemarket705-prog/forge-send-console`) — à relancer par email à
   envoyer si les ticks tardent.
5. **Récupère les décisions** quand le lot est terminé (`--send-pull`) : les
   mds portent `status: sent` (`sent_at`, texte exact envoyé — syncé dans la
   section `## Email draft` si l'email avait été modifié) ou
   `rejected_manual` (raison dans `error`), et la console est vidée.

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
  re-queue) ou `rejected_manual` (raison dans `error`). Le
  `outreach/contact_ledger.csv` est régénéré automatiquement : le verdict
  reste enregistré même si un md est supprimé.
- **Le md = ce qui est réellement parti.** La décision `sent` enregistre le
  texte exact (sujet + corps) ; si l'email a été modifié sur la console, le
  pull réécrit la section `## Email draft` du md avec ce texte avant
  d'enregistrer la décision.
- **Modifier = règles maison appliquées côté serveur** (`api/revise.js`) : le
  sujet recommence par `[Partnership] ` et le corps se termine par
  `-Ronan Delerue` + `Forge — https://forgefitapp.co/` — comme
  `ensure_house_rules` côté writer local. Une révision est marquée sur la
  carte (`✏️ modifié`) et gelée telle quelle dans le lot au verrouillage.
- La console terminale (`python run_forge_outreach.py --send`) reste
  disponible — c'est l'autre chemin d'envoi, avec confirmation par adresse
  tapée par email. Le lot web et la console terminale partagent le même
  format de décision dans les mds.

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
prior-decision (le `tk` est relu dans le corps de la décision).

**Endpoints** :

| Endpoint | Auth | Rôle |
|---|---|---|
| `GET /api/pix?tk=…` | **aucune** | pixel d'ouverture : 200 `image/gif` 42 octets toujours (tk mort inclus) + événement `open` si le tk est connu |
| `GET /api/r?tk=…` | **aucune** | clic : 302 vers le site toujours (tk mort inclus) + événement `click` si connu |
| `GET /api/kpi` | token | agrège opens/clics/réponses par prospect + totaux (voir l'onglet) |
| `POST /api/kpi` | token | marque une réponse `{username, outcome: positive\|neutral\|negative\|bounce}` — **sémantique de remplacement** (re-marquer ne double jamais) ; `outcome` vide **retire** la marque |

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
| `FORGE_CONSOLE_TOKEN` | `<à générer>` — **identique** au secret GitHub et au `FORGE_CONSOLE_TOKEN` du `.env` local ; le navigateur le demande une fois |
| `DEEPSEEK_API_KEY` | la clé DeepSeek du `.env` local — nécessaire au bouton **Modifier** (`api/revise.js` appelle l'agent writer depuis le serveur). Sans elle : 500 « modifier cannot run ». Modèles/endpoint surchargeables via `FORGE_REVISE_MODEL` / `FORGE_REVISE_BASE` |
| `FORGE_TRACK_BASE` | `https://go.forgefitapp.co` — l'origine des liens de tracking réécrits dans chaque email (pixel + clic). Surchargeable pour un test local ; sans elle, les liens pointent vers `go.forgefitapp.co` par défaut |

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
  `decide`/un nouveau `lock` — un double envoi est impossible même avec deux
  onglets ouverts (le serveur garde l'historique).
- **Le lot gèle le texte** : l'envoi lit le snapshot du lot, plus jamais la
  file — un `--send-push` concurrent ne peut pas changer ce qui a été
  verrouillé.
- **Envoi sans double, sans perte** : `/api/batchsend` n'est joignable que
  par `/api/senddue` (donc par le cron) avec le secret du lot ; un claim
  `SET NX` par prospect dédoublonne les ticks qui se chevauchent, et la
  décision `sent` est enregistrée **avant** la mise à jour du statut (un
  crash entre les deux est réparé par le tick suivant). SMTP en échec = rien
  d'enregistré + réponse 502 → le tick suivant réessaie naturellement.
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
