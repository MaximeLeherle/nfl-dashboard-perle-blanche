# Suivi d'équipe · No Finish Line Monaco 2026

Tableau de bord en direct d'une équipe à la [No Finish Line Monaco](https://nfl.childrenandfuture.com/no-finish-line/resultats/) (14 → 22 novembre 2026, boucle de 1,054 km).
Site statique sur GitHub Pages, sans compte : tout le monde ouvre la même adresse.

## Ce qu'on y trouve

- **Équipe** : total de km et de tours, classement parmi toutes les équipes avec l'écart en tours avec l'équipe devant et derrière, km du jour, coureurs en piste, courbe des km cumulés, rythme par heure ou par jour, podium et liste des coureurs (recherche, filtres).
- **Fiche coureur** (`#coureur-<dossard>`) : km, tours, classements général / catégorie / sexe, place dans l'équipe, progression et km par jour.
- **Comparer** (`#comparer-<dossard>-<dossard>`) : deux coureurs de l'équipe face à face.
- **Suivre** : l'étoile garde des coureurs en haut de page (mémorisé dans le navigateur de chacun).

## Comment ça marche

```
GitHub Actions (toutes les 15 min)
  └─ scraper/scrape.mjs ──► API publique Sportips
       ├─ data/roster.json   coureurs de l'équipe (recherchés 1 fois par jour)
       ├─ data/history.json  un relevé par ligne : équipe + coureurs ayant roulé
       └─ data/latest.json   dernier passage, erreurs, stats de tous les coureurs
index.html + app.js  ──► lisent config.json et data/, se rafraîchissent toutes les 5 min
```

API utilisée (publique, sans token) : `https://inscription.sportips.fr/api/chronometrie/endpoints/public`

| Appel | Usage |
|---|---|
| `GET /event/get.php?base=NFL26` | identifiant de l'événement |
| `POST /races/get.php` `{event_id}` | courses de l'événement |
| `POST /results/get.php` `{id_race, search_terms, order_by, page, limit≤100}` | tours, km, classements d'un coureur |
| `GET /customResults/list.php?event_id=…` puis `/customResults/get.php?id=…&page=…&limit=100` | classement des équipes |

Le relevé fait **un appel par dossard** toutes les 15 min, plus 5 appels pour le classement des équipes. La recherche des membres de l'équipe (≈ 130 appels) n'a lieu qu'une fois par jour.
L'API ne publie pas l'heure de chaque tour : le « dernier tour » et les courbes viennent des relevés, à 15 min près.

## Réglages (`config.json`)

- `team.organization` : le nom de l'équipe **exactement comme chez Sportips** (colonne « Équipe »).
- `team.color` / `colorDark` : couleur de l'équipe ; `compareColor` : couleur du 2e coureur dans « Comparer ».
- `extraRunners` : dossards à ajouter même s'ils ne sont pas inscrits sous l'équipe, ex. `[1234, 5678]`.
- `excludeBibs` : dossards à retirer.
- `rosterRefreshHours` : fréquence de la recherche des membres (24 h par défaut).

Pour forcer une nouvelle recherche des membres : onglet **Actions** → « Relevé Sportips » → **Run workflow** → cocher « Reconstruire la liste des coureurs ».

## En local

```bash
npm run scrape            # un relevé (Node 20+, aucune dépendance)
REFRESH_ROSTER=1 npm run scrape   # en refaisant la recherche des membres
npm run serve             # puis http://localhost:8000
```

Le relevé s'arrête tout seul 6 h après la fin de l'événement (`FORCE=1` pour passer outre).
