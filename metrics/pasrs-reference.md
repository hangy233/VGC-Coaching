# PASRS 7.0 workbook inspection

Inspected the actual public PASRS 7.0 template, rather than relying only on its release description. This is an original structural and metric analysis, not a copy of its parser or workbook implementation.

- [Official release article](https://devoncorp.press/resources/the-release-of-pasrs-7-0)
- [Public Google Sheets template](https://docs.google.com/spreadsheets/d/1HdwhV6AlRP-El7WdfHoLwz315zov2O9BSeoyMG37NHo/edit)
- Read-only downloaded reference: `cache/pasrs-reference/PASRS-7.0.xlsx`
- Reference SHA-256: `1a144a632bfc0c03eb3f319e3bc3603f251a0b320ee6a058de4e5f185e5a62ff`
- Template identifies itself as version 7.0, April 12, 2026 (`FAQ  Contact!H8`).

Cell references below were verified in that workbook's XML. No workbook cells were edited or recalculated. Google Sheets-only expressions survive the Excel export inside compatibility wrappers; cached empty-template errors are not evidence of live Google Sheets behavior.

## Structure and ingestion

The workbook has 27 tabs: 8 visible and 19 hidden. The visible tabs are `FAQ  Contact`, `Home`, `Replay Entries`, `Game By Game`, `Match by Match`, `Usage`, `Matchup Stats`, and `Move Usage`.

1. `Home!G6:K6` supplies player aliases. `Home!G8` supplies the team Pokepaste URL.
2. `Team Info From Paste!A1` calls the custom function `IMPORTTEAM`. Its parsed output supplies species, nickname, four moves, item, ability and training fields in `C2:S7`. `N2` invokes `PARSEEVSTRING`; `E19` invokes `GRABTEAMNAME`.
3. `Replay Entries!C7:C506` accepts up to 500 replay entries. `Base Data!B3` invokes custom `REPLAYTODATA` on the first replay link, with one corresponding row per replay. `Replay Entries!F7` flags duplicate links, and the hidden `Errors` tab checks invalid links, unmatched player names and duplicates.
4. `Base Data` holds the parser's players, six-Pokémon previews, winner, lead and used-Pokémon fields, OTS, ratings, BO3 flags and move-count payload. Formulas in `DC3:EO3` orient these fields to the player's configured aliases. `DR3` identifies which replay player matches an alias, and `EF3` derives Win/Loss.
5. `GBG Data` assembles game rows. `GBG Filtered!A1` queries those rows using conditions from `GBG DASHBOARD`. `FilteredReporting` builds the filtered own-Pokémon metrics, and visible `Usage` reads them.

The four custom functions are referenced but their implementations are **not included in the public XLSX**. There are no Apps Script or JavaScript source files in the archive. Consequently, the export establishes the parser's output contract and downstream calculations, but does not reveal exactly how `REPLAYTODATA` fetches replay content, handles called/failed moves, deduplicates events, identifies unseen reserves, or attributes Illusion. No equivalence claim about those internals is justified from this workbook alone.

## Verified metric definitions

| Metric | Definition from workbook dependencies | Verified cells |
| --- | --- | --- |
| Resolved games | Wins plus losses; unknown/tied results are not included in this denominator. The custom parser's tie handling is unavailable. | `Report!B3:B6`; `FilteredReporting!B4:B9` |
| Own usage rate | Games whose parser-reported used-four contains the Pokémon, divided by resolved games. | `Report!E5:H5`; `FilteredReporting!B12:E12` |
| Win rate when used | Wins in those used-Pokémon games, divided by games used. | `Report!F5:G5`; `FilteredReporting!D12:E12` |
| Own lead rate | Games led divided by resolved games. | `Report!E14:H14`; `FilteredReporting!F12:I12` |
| Win rate when led | Wins with that Pokémon leading, divided by games led. | `Report!F14:G14`; `FilteredReporting!G12:I12` |
| Mega win rate | Wins in which the tracked transformation field contains the Pokémon, divided by its transformation count. Visible labels say Mega; several hidden source headers retain older Tera names. The custom parser's actual Mega field production cannot be inspected. | `FilteredReporting!J12:L12`; visible `Usage!P8:S8` |
| Lead-pair win rate | Wins with the unordered pair in the two lead positions, divided by appearances of that pair. | `Lead Combo Reporting!H6:J6`; filtered counterpart has the same meaning |
| Opponent preview count | Number of six-Pokémon preview entries containing that species. | `OpponentData!D2`; named `OppMonsOwned` |
| Opponent games faced | Number of parser-reported used-four entries containing that opponent species. This is distinct from preview presence. | `OpponentData!E2`; named `OppMonsUsed` |
| Win rate versus opponent species | Wins in games where that species is in the parser's used-four, divided by games faced. | `OpponentData!F2:G2` |
| Opponent attendance | Games faced divided by preview presence. | `OpponentData!H2` |

Best/worst opponent matchups require more than three games faced; attendance rankings require more than three preview appearances (`OpponentData!I1`, `N1`, `I8`, `N8`). These cutoffs are sample filters, not proof that four games establish matchup strength.

## Move counting

The replay custom function supplies colon-separated Pokémon/move/count records bracketed by per-side move markers. `Base Data!EH3:EL3` finds the correct player's marker range. `Move Data TEST!C2:E2` retrieves that range; `Move Data TABLE!A2:F2` flattens it and separates the actor, move and numeric count.

`Move Data TABLE!G1:H5` then matches the pasted Pokémon's normalized name or nickname and sums counts for each of its four registered moves. The same layout repeats for the other five Pokémon. The six doughnut charts on `Move Usage` reference those small total tables; for example, the first reads `Move Data TABLE!G2:H5`.

These are total reported counts, not counts per selected game or a success rate. The move pipeline reads unfiltered `Base Data`, while the main `Usage` view reads `GBG Filtered`. Thus the inspected workbook does not apply its game filter to the move charts. A local report that recomputes every metric after filtering has a deliberate semantic improvement, not exact display parity.

No exposed worksheet label, formula or reporting column implements knockouts, faints, or Knock Off item-removal counts. Those are additional metrics in this repository. Their definitions must be documented independently. The unavailable replay custom function prevents a definitive claim about whether PASRS includes failed or called move announcements in its numeric payload.

## BO3, filters and team identity

`Base Bo3 Data!B2` selects replay rows marked as BO3. It exposes game number, result and a last-game flag. `A3` keeps the preceding sequential set number until the prior row is marked as the last game; it then increments. `MBM Data!B2` obtains a set's displayed result from its last-game row. `J2` assembles the W/L sequence for games 1–3, and `K2:M2` retrieves those replay links. This is a row-order-based grouping scheme; the local client can instead use its observed official parent-room ID.

`GBG DASHBOARD!E1:E11` builds filters for result, opponent preview species, opponent lead/back, own used species, own lead/back, tracked Mega, OTS/CTS and minimum opponent rating. The final `GBG Filtered!A1` expression combines result, opponent, lead/back, Mega, OTS and rating conditions. Although an own-used query is defined in `E5`, that final expression does **not reference** it in this export; that control's operation is not established by its mere presence.

There is no exposed cryptographic team-version fingerprint. Instead, `FAQ  Contact!C12` instructs users to keep a consistent team and matching nicknames and create a fresh workbook when changing the team. `Forms!A:C` supplies display/move identity mappings; several formulas also remove Mega suffixes. This repository's exact validated team hash provides a stronger separation of samples across move/item/training changes.

## Implications for this implementation

- Keep preview presence separate from observed opponent selection. Do not call an opponent-preview win rate the same metric as PASRS's selected-opponent win rate.
- Record an actual Mega event independently of registered Mega forms. Registration alone does not establish that the Pokémon Mega Evolved in a game.
- Treat lead pairs as unordered. Show their game count with win rate.
- Preserve unknown reserve choices. A public replay often cannot prove every selected Pokémon; its unobserved reserves are not known exclusions.
- Keep all report filter effects explicit, and show denominators rather than confusing zero samples with zero success.
- Separate move uses, confirmed Knock Off item removals and direct enemy KOs. The last two add information beyond the inspected PASRS tables.
- Parser semantics should remain tested against protocol fixtures, including spread attacks, residual damage, own-side orientation, nicknames, forms, switchbacks and Illusion. The reference's unavailable custom-function implementation cannot substitute for those tests.
