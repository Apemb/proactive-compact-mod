# proactive-compact-mod

Mod Claude Code qui laisse l'agent **préparer et choisir son compactage**, au lieu de le subir quand le contexte est
plein.

Sans lui, une longue session finit compactée automatiquement, au milieu d'un travail, sans que l'agent ait mis ses
mémoires à jour : ce qui n'était pas consigné se perd dans le résumé. Le mod prévient l'agent assez tôt, lui donne de
quoi mesurer son contexte, et lui permet de lancer lui-même le compactage au moment qu'il juge bon.

## Ce qu'il fait

| Élément | Rôle |
|---|---|
| **Demande** de compactage | À la fin d'un tour de la session principale, si le contexte brut atteint `seuilDemande` (60 % par défaut), le mod envoie un message qui demande à l'agent de mettre ses mémoires à jour puis d'appeler `compacter_session`. Une fois par cycle. |
| **Relance** | Même chose à `seuilRelance` (80 % par défaut), si l'agent n'a pas compacté. Un saut direct au-delà de ce seuil n'envoie que la relance. |
| Outil `contexte_session` | Rend à l'agent les tokens utilisés, la fenêtre, le pourcentage, les seuils et l'état des messages. Avec `detail: true`, la ventilation par catégorie et le seuil du compactage automatique. |
| Outil `compacter_session` | **Programme** le compactage, exécuté à la fin du tour en cours : Claude Code refuse de compacter pendant un tour. Il accepte des `instructions`, ce que le résumé doit garder. Refusé sous `plancher` (40 % par défaut), annulé si le tour est interrompu. |
| `/compactage` | `statut` (défaut), `on`, `off`, `reglages`. |

Tout compactage réussi, celui de l'agent, un `/compact` ou l'automatique, réarme la demande et la relance. Les tours
des sous-agents sont ignorés, et les deux outils leur sont refusés : ils ne lisent que la session principale.

Les outils apparaissent pour l'agent sous `mcp__proactive-compact-mod__contexte_session` et
`mcp__proactive-compact-mod__compacter_session`.

## Réglages

Les réglages globaux se changent dans `/config`, aux lignes `proactive-compact-mod` :

| Réglage | Défaut | Rôle |
|---|---|---|
| `actif` | `true` | Envoie la demande et la relance. Les outils restent offerts dans tous les cas. |
| `seuilDemande` | `60` | Pourcentage brut du contexte qui déclenche la demande. |
| `seuilRelance` | `80` | Pourcentage brut qui déclenche la relance. |
| `plancher` | `40` | En dessous, `compacter_session` refuse. |
| `messageDemande` | texte fourni | Message de la demande. |
| `messageRelance` | vide | Message de la relance ; vide, celui de la demande sert. |
| `complement` | vide | Ajouté à la fin des deux messages. |
| `instructionsCompactage` | vide | Passées au résumé, avant celles de l'agent. |

Les messages acceptent les variables `{pourcentage}`, `{seuil}`, `{plancher}` et `{outil}`.

**Surcharge par projet.** Dans le `.claude/settings.json` du dépôt (partagé) ou son `.claude/settings.local.json`
(personnel), qui l'emporte :

```json
{
  "pluginConfigs": {
    "proactive-compact-mod": {
      "options": {
        "seuilDemande": 50,
        "complement": "Mets aussi à jour docs/processus/releve-taches.md."
      }
    }
  }
}
```

Ces surcharges sont relues à chaque usage : une modification prend effet sans recharger le mod. `/compactage` indique
d'où vient chaque valeur.

## Installer

Le mod est un plugin à hooks de fonction de Claude Code (API en accès anticipé, écrit sous Claude Code 2.1.301).

- **Pour toutes les sessions** : ajouter le dossier du dépôt à `CLAUDE_CODE_PLUGIN_DIRS`, dans le bloc `env` de
  `~/.claude/settings.json` :
  ```json
  { "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/proactive-compact-mod" } }
  ```
- **Pour une session** : `claude --plugin-dir /path/to/proactive-compact-mod`.

En session interactive, le dossier est surveillé : une modification recharge le mod.

## Développer

```sh
claude plugin validate .   # ce que le module accroche et appelle, et ce que le moteur refuserait
claude plugin test .       # tests/*.test.ts contre le moteur
tsc -p .                   # une fois le mod chargé, quand Claude Code a posé .claude-plugin/types/
```

| Fichier | Contenu |
|---|---|
| `.claude-plugin/plugin.json` | Manifeste et réglages (`userConfig`). |
| `hooks/register.ts` | Hooks : fin de tour, compactage, outils, commande. |
| `hooks/reglages.ts` | Fusion des réglages (défauts, global, projet, local) et gabarit des messages. |
| `types/index.d.ts` | Contrat de l'état de session (`$.state`). |
| `tests/` | Tests de comportement. |

`.claude-plugin/types/` est écrit par Claude Code à chaque chargement et n'est pas versionné.

## Limites connues

- Les sous-agents n'ont ni les messages ni les outils : la mesure de leur propre contexte reste à faire.
- Un `plancher` supérieur à `seuilDemande` rend la demande inutile, car l'outil refuserait de compacter. Le mod ne le
  signale pas encore.
- Le `⚠` qui précède l'état dans la barre d'état est posé par Claude Code ; l'API ne permet pas de le changer.
