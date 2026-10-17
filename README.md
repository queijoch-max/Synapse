# Synapse V2 — second cerveau & suivi de projet

Une seule app, **100 % gratuite**, avec deux espaces accessibles depuis les onglets en haut de la barre latérale :

- **📚 Formation** : un second cerveau, mélange de Notion et de NotebookLM. On y écrit ses cours, tout est relié, une recherche retrouve n'importe quelle info, et une IA gratuite (Google Gemini) explique les notions difficiles, résume les cours, transforme les PDF en fiches et génère des quiz.
- **🚀 Suivi de projet** : un tableau de bord personnel avec les tâches du jour et du mois, les projets (Kanban et tableau), l'agenda, un bloc-notes et des post-its, plus la météo locale.

## 📚 Onglet Formation

| Besoin | Dans Synapse |
|---|---|
| Écrire ses notes au fur et à mesure | Éditeur Markdown avec sauvegarde automatique. `Ctrl E` bascule entre écriture et lecture |
| Séparer ses formations | Des **onglets** en haut, un par formation (ex. Python, AI Engineer, Full Stack…). Chaque onglet a ses propres cours, sa recherche, son graphe, son assistant et ses quiz. **+** ajoute une formation ; ✎ permet de la renommer, de changer sa couleur, de la réordonner ou de la supprimer |
| Tout relier comme une base de données | 3 types de notes : **Cours**, **Notions**, **Fiches**. Une notion ou une fiche appartient à un cours, et `[[Nom]]` relie n'importe quelle note à une autre (avec autocomplétion). Chaque page affiche ses liens sortants et les notes qui la mentionnent. Un graphe montre toutes les connexions |
| Retrouver une info | `Ctrl K` : recherche dans les titres, les tags, le contenu et le texte des PDF, insensible aux accents, dans l'onglet actif ou dans toutes les formations |
| Un agent qui connaît tous les cours | Page **✦ Assistant** : l'IA a des outils pour lister, chercher et lire toutes les notes de la formation, et pour créer des fiches. Exemples de demandes : « résume ma semaine », « quiz sur tous mes cours », « mes points faibles ». Elle cherche elle-même dans la base et affiche ce qu'elle lit |
| Faire décortiquer un cours précis | Bouton **✦ Décortiquer** sur une note : en profondeur, explication simple, exemples, quiz, ce qui manque, ou question libre |
| Importer des PDF rangés en dossiers | Glisser un **dossier** dans la fenêtre, ou utiliser le bouton **Dossier**. La fenêtre d'import demande ce que contient le dossier (**plusieurs formations**, **une formation** ou **un module**) et la **formation de destination**, puis montre un aperçu de l'endroit où chaque fichier sera rangé avant de valider. `Formation / Module / Chapter 1.pdf, Chapter 2.pdf…` devient onglet › module › chapitres, dans l'ordre (1, 2… 10) ; les sous-dossiers plus profonds sont rangés dans leur module. Un fichier déjà présent dans le même module de la même formation est ignoré, même si un autre module porte le même nom ailleurs. Le texte des PDF est lu localement (gratuit, sans IA) : il est cherchable tout de suite et l'assistant peut le lire. Le PDF original reste consultable dans l'app |
| Ajouter ses propres fiches | Bouton **📎 Ma fiche** sur un chapitre : Markdown, texte, HTML, Word (.docx) ou PDF. Dans un import de dossier, une fiche est attachée automatiquement à son chapitre si elle porte le même nom (`Chapter 1.md`, `Chapter 1 - fiche.pdf`, `Chapter 1 synthèse.docx`) ou si elle est rangée dans un sous-dossier `Fiches` / `Synthèses` du module. Les chapitres qui ont déjà une fiche ne consomment pas de requête IA. Ces fiches sont cherchables et servent aux quiz et à l'assistant |
| PDF → fiche synthèse | L'IA rédige une fiche par chapitre (notions clés reliées, exemples, pièges, questions de révision), une par une en arrière-plan. Le bouton **✦ Générer les fiches** d'un module permet de reprendre plus tard |
| Ranger et faire le ménage | Page **🗂️ Gérer** (ou « Sélectionner… » sur un module) : cocher plusieurs cours, chapitres ou notes, puis les **supprimer** ou les **déplacer** vers un autre module ou une autre formation. Cocher un cours coche aussi ses chapitres. Supprimer un module propose aussi de supprimer ses chapitres |
| S'entraîner | Page **🎯 Quiz**, ou bouton Quiz sur une fiche ou un module : QCM et vrai/faux sur les fiches choisies, corrigés avec explications. Les questions déjà posées sont mémorisées et ne reviennent jamais |

## 🚀 Onglet Suivi de projet

| Page | Contenu |
|---|---|
| **Tableau de bord** | Vue d'ensemble du jour : météo locale avec un petit conseil, tâches du jour à cocher, projets en cours avec leur avancement, mini-calendrier du mois et rendez-vous / échéances des 7 prochains jours, derniers post-its |
| **Tâches** | Deux listes : *Aujourd'hui* et *Ce mois-ci*, avec progression. Cocher, modifier (titre, description), passer d'une liste à l'autre (↑ ↓), supprimer, masquer ou vider les tâches terminées. Le champ en haut de la barre latérale ajoute une tâche du jour depuis n'importe quelle page |
| **Projets** | Vue **Kanban** (À faire / En cours / Terminé) avec glisser-déposer, ou vue **Tableau** triable par nom, statut, avancement ou échéance. Chaque projet a une description, un avancement (0-100 %), une échéance (en orange si elle approche, en rouge en cas de retard) et peut être lié à une formation |
| **Agenda** | Calendrier mensuel : clic sur un jour pour ajouter un rendez-vous (date, heure, description). Les échéances des projets y apparaissent automatiquement (🚩), suivies de la liste des prochains événements |
| **Bloc-notes & post-its** | Notes rapides datées (Markdown accepté) et post-its de couleur (jaune, orange, rouge, vert), modifiables directement en cliquant dessus |

La **météo** vient d'Open-Meteo (gratuit, sans clé) : on choisit sa ville dans le tableau de bord ou dans **Réglages → Météo du tableau de bord**, ou on utilise sa position.

## Pourquoi c'est gratuit

- **Hébergement** : ce sont uniquement des fichiers HTML, CSS et JS statiques. Pas de serveur, pas de base de données à payer, pas de compilation.
- **Données** : les notes sont stockées **dans le navigateur**, sur l'appareil de l'utilisateur (IndexedDB, comme localStorage mais en beaucoup plus grand).
- **IA** : Google Gemini, avec une clé gratuite créée sur Google AI Studio, sans carte bancaire. Elle est appelée directement depuis le navigateur.

⚠️ À savoir :
- **Quota gratuit** : Google limite le nombre de requêtes par minute et par jour, et ces limites changent souvent. Le modèle *Flash-Lite* (par défaut) a le plus gros quota. En cas de « quota atteint », il suffit d'attendre un peu ou de changer de modèle dans les Réglages. Une question à l'assistant peut consommer plusieurs requêtes, une par étape de recherche ou de lecture.
- **Coût en requêtes** : une fiche IA = 1 requête par PDF ; un quiz = 1 requête.
- **Confidentialité** : avec l'offre gratuite, Google peut utiliser les contenus envoyés pour améliorer ses modèles. Mieux vaut ne rien envoyer de confidentiel à l'IA.
- **Les données vivent dans le navigateur.** Pour changer d'appareil ou de navigateur : **Réglages → Exporter tout (.json)**, puis **Importer** de l'autre côté. Exporter une sauvegarde régulièrement est recommandé : vider les données du site efface tout.
- La sauvegarde .json contient **les deux onglets** : formations, notes, fiches, texte des PDF, mais aussi tâches, projets, agenda, bloc-notes et post-its. Elle ne contient **pas les fichiers PDF eux-mêmes** (trop lourds). Il faut donc conserver les PDF d'origine : on peut les réimporter, et les chapitres déjà présents sont ignorés.
- Une sauvegarde de la première version de Synapse s'importe telle quelle dans Synapse V2. Les deux versions utilisent des bases séparées dans le navigateur et ne se gênent pas.

## Activer l'IA (1 minute)

1. Aller sur https://aistudio.google.com/apikey avec un compte Google
2. Cliquer sur **Create API key** et copier la clé
3. Dans Synapse : **Réglages → Clé API Gemini**. **Charger mes modèles** vérifie que la clé fonctionne, puis **Enregistrer**

Optionnel : Claude (Anthropic) est aussi disponible dans les Réglages, mais il est payant à l'usage.

## Lancer en local

Le site doit être servi par un petit serveur web : ouvrir `index.html` d'un double-clic ne fonctionne pas, à cause des modules JS. Depuis le dossier du projet :

```bash
python -m http.server 5173
```

Puis ouvrir http://localhost:5173

## Héberger gratuitement

Le site est statique : n'importe quel hébergeur de sites statiques convient, sans commande de build.

### Vercel
1. Importer le dépôt GitHub sur https://vercel.com/new
2. **Framework Preset** : `Other`. Laisser **Build Command** et **Output Directory** vides
3. Chaque push sur la branche principale redéploie le site

### Netlify Drop (sans Git)
1. Aller sur https://app.netlify.com/drop
2. Glisser **tout le dossier** du projet
3. Le site est en ligne sur une URL du type `https://nom-du-site.netlify.app`

### GitHub Pages
1. Pousser les fichiers sur un dépôt GitHub
2. Dans le dépôt : **Settings → Pages → Deploy from a branch → `main` / root**
3. Le site est disponible sur `https://pseudo.github.io/nom-du-depot/`

Cloudflare Pages fonctionne aussi, de la même façon.

> Le site hébergé est public, mais **les notes et la clé API restent dans le navigateur de chaque utilisateur**. Une personne qui ouvre l'URL voit une app vide, sans les données ni la clé de personne d'autre.

## Structure

```
index.html        page unique
css/style.css     thème sombre
css/pilot.css     styles de l'onglet Suivi de projet
js/app.js         interface, les deux espaces, onglets de formation, éditeur, import, quiz, panneaux IA, réglages
js/pilot.js       suivi de projet : tableau de bord, tâches, projets, agenda, bloc-notes, post-its, météo
js/agent.js       agent : outils (lister / chercher / lire / créer une fiche) + boucle
js/ai.js          appels IA (Gemini gratuit ou Claude) : explications, PDF → fiche, quiz
js/pdf.js         lecture locale du texte des PDF (pdf.js)
js/fiche.js       fiches personnelles : lecture md / txt / html / docx / pdf et association aux chapitres
js/db.js          stockage IndexedDB (formations, notes, PDF, suivi de projet) + calcul des liens
js/search.js      recherche plein texte
js/graph.js       graphe des connexions
```

Charlotte QUEIJO