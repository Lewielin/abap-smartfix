# ABAP SmartFix

> Auto Fix ATC Findings, Pragmas and Modern Syntax for SAP ABAP

![ABAP SmartFix demo](media/demo.gif)

A VS Code extension for **SAP ABAP** development. It lists the **ATC / Code Inspector findings** in your ABAP code and fixes them automatically:

- **Safe rewrites are applied to the code directly**, e.g. a `SELECT SINGLE` without the full primary key → `SELECT … UP TO 1 ROWS … ENDSELECT`, `MOVE a TO b` → `b = a`, commenting out `BREAK-POINT`.
- **Everything else gets a Pragma (`##…`) or Pseudo Comment (`"#EC …`)**, placed at the right position even in multi-line and chained statements.
- **Anything that can be done neither way is marked for manual fixing**, and a complete prompt can be generated for your AI assistant.

### What makes it smart

abap-cleaner tidies code; it does not know about ATC. ABAP SmartFix starts from the ATC / Code Inspector findings and adds:

- **Annotation names checked against SAP, not guessed.** Every rule names its SCI check class, and its pseudo comment / pragma is the one that check's message uses in the SCI message catalog of an S/4HANA system (e.g. `SELECT SINGLE` → `"#EC CI_NOORDER` of "SELECT SINGLE is possibly not unique"). Checks whose name, position or limits could not be confirmed are left out rather than guessed.
- **Works entirely in VS Code.** Nothing to install or run in the SAP system.
- **Learns from your code base.** **Learn Annotation Names from Workspace** looks at the annotations your team already uses on the reported statements and offers them as `tokenOverrides`.
- **Self-checking fixes.** Every rewrite is applied in memory and analyzed again first. If the IF / LOOP / SELECT … ENDSELECT structure would change, or the finding would still be there, the rewrite is dropped and falls back to an annotation or a manual fix.
- **Minimal changes to your code.** Only the words that must change are touched: no re-indenting, no reformatting, comments stay. Rewrites that change behavior (for example wrapping a FOR ALL ENTRIES in `IF … IS NOT INITIAL`) are only applied when you ask for them (`fixMode: rewrite`, the Quick Fix, or the sidebar).
- **Explains the context**, e.g. "inside the loop in line 120", "driver table gt_mara", "the LOOP in line 1602".

## Requirements

VS Code 1.80 or later. No Node.js and no SAP connection needed.

## Usage

1. Open an `.abap` file and run **ABAP SmartFix: Analyze Current File** (from the editor context menu, the editor title button, or automatically on save).
2. Findings are shown in:
   - **Problems panel**: one diagnostic per finding; auto-fixable ones are marked `[Auto-fixable]`.
   - **ABAP SmartFix sidebar**: findings grouped by file with their fix; click one to jump to the line.
     Each finding has a checkbox: **unchecked findings are left out of every auto fix** (file, workspace, preview, fix on save).
     Check or uncheck a file to do it for all its findings, or use **Check All Findings** / **Uncheck All Findings** in the `…` menu.
     The wand button on a finding fixes just that one.
   - **Status bar**: the total number of findings.

   While you type, an analyzed file is analyzed again once typing pauses (about 0.5 s), so line numbers stay current.
   Closing a file removes its findings; files that were only scanned by **Analyze Workspace** and never opened stay listed.
3. Right-click in the editor and pick how to fix them:

| To do this | Command |
| --- | --- |
| See the changes first | **ABAP SmartFix: Preview Fixes** |
| Fix automatically (rewrites + annotations, asks first) | **ABAP SmartFix: Auto Fix Current File** |
| Only add annotations, leave the code as is | **ABAP SmartFix: Add Pragmas & Pseudo Comments Only** |
| Hand it to an AI assistant | **ABAP SmartFix: Copy AI Prompt**, then paste it |
| Fix a single line | Put the cursor on the line → `Ctrl+.` → pick a Quick Fix |
| Choose what to fix in a block of code | Select the lines → right-click → **ABAP SmartFix: Fix Findings in Selection…** (or `Ctrl+.`), then keep the findings to fix checked |

To fix a whole project, use **Analyze Workspace** and then **Auto Fix Checked Findings in All Files** in the sidebar.
All changes are applied as one edit, so a single `Ctrl+Z` undoes them; files are not saved automatically.

More commands: **Generate Markdown Report**, **Show Rules** (every rule with its annotation and SCI check class), **Learn Annotation Names from Workspace**, **Clear Results**.

### When your system uses other annotation names

Custom ATC checks or other releases can accept other names. Run **Learn Annotation Names from Workspace**: it looks at the annotations your code already carries on the reported statements and offers the ones used consistently as `abap-smartfix.tokenOverrides`. You can also set them yourself:

```jsonc
"abap-smartfix.tokenOverrides": { "sort-in-loop": "\"#EC CI_SORT_IN_LOOP" }
```

> ABAP SmartFix reads the source only; findings that need the DDIC, the compiler or other programs cannot be seen. After an auto fix, run the syntax check and ATC again in your SAP system.

### Auto fix on save

```jsonc
"[abap]": {
  "editor.codeActionsOnSave": { "source.fixAll.abap-smartfix": "explicit" }
}
```

## Supported checks

| Annotation | Check (SCI check class) | Rewrite |
| --- | --- | :-: |
| `"#EC CI_SUBRC` | `sy-subrc` not checked after database access, `READ TABLE`, `AUTHORITY-CHECK`, `CALL FUNCTION … EXCEPTIONS` (SYSUBRC; this check has no pragma) | |
| `"#EC CI_NOORDER` / `"#EC WARNOK` | `SELECT SINGLE` that clearly does not use the full primary key: "SELECT SINGLE is possibly not unique" (NO_ORDER_BY). Reported when there is no `WHERE`, or `OR` / `NOT` / `IN` / `LIKE` / `BETWEEN` / range comparisons / dynamic conditions; a `WHERE` made only of `=` conditions joined by `AND` is treated as the full key (`selectSingleCheck: all` lists every one) | ✅ |
| — | `SELECT … INTO TABLE` without `ORDER BY` whose result is later used in an order-dependent way (NO_ORDER_BY; ATC reports it on the later statement with `"#EC CI_SORTED`) | ✅ `ORDER BY PRIMARY KEY` (review) |
| `"#EC CI_NOWHERE` | `SELECT` without `WHERE` (SELECT_TAW_A) | |
| `"#EC CI_SEL_NESTED` | `SELECT` inside a loop (SELECT_NESTED) | |
| `"#EC CI_DYNTAB` / `"#EC CI_DYNWHERE` | Dynamic table name / dynamic `WHERE` condition in SQL (SELECT_TAW_SEC01, IMUD_TAW_SEC01) | |
| `"#EC CI_CLIENT` | `CLIENT SPECIFIED` (SELECT_TAW_SEC01, IMUD_TAW_SEC01) | |
| `"#EC CI_STDSEQ` | Linear search on a standard table (ITAB_PERFORMANCE; inside a loop SEQ_ACC_ITAB_NESTED) | |
| `"#EC CI_CALLTA` / `"#EC CI_SUBMIT` | `CALL TRANSACTION` (not with `WITH AUTHORITY-CHECK`) / `SUBMIT` (CRITICAL_STATEMENTS) | |
| `##NO_BREAK` / `"#EC NOBREAK` | `BREAK-POINT` / `BREAK user` (extended check) | ✅ |
| `##NO_HANDLER` | Empty `CATCH` block (extended check) | |
| `##LOOP_AT_OK` / `"#EC AT_LOOP_WH` | `AT NEW` / `AT END OF` / `AT FIRST` / `AT LAST` in a `LOOP … WHERE / FROM / TO` (extended check) | |
| `##NEEDED` | Declared but never used (extended check) | ✅ |
| `##NO_TEXT` | Text literal without a text symbol, also in string templates (extended check) | |
| `##CALLED` | `FORM` without a matching `PERFORM` (extended check; off by default) | |
| — | Obsolete syntax: `MOVE` (`?TO`, `EXACT`), `ADD` / `SUBTRACT` / `MULTIPLY` / `DIVIDE` (→ `+=` etc.), `COMPUTE`, `REFRESH`, `DESCRIBE TABLE … LINES`, `CALL METHOD` (`RECEIVING` → `x = m( )`), `CREATE OBJECT`, `GET REFERENCE OF` | ✅ |
| — | Obsolete pseudo comments to pragmas (the SLIN table, 129 pairs checked against SAP): `"#EC NEEDED` → `##NEEDED`, `"#EC NOBREAK` → `##NO_BREAK`, … | ✅ |

Performance, robustness and security checks (see [SCI-COVERAGE.md](SCI-COVERAGE.md)):

| Check (SCI check class) | Annotation | Rewrite |
| --- | --- | :-: |
| Database change (`INSERT` / `UPDATE` / `MODIFY` / `DELETE`) inside a loop (IMUD_NESTED) | `"#EC CI_IMUD_NESTED` | ✅ `LOOP … MODIFY dbtab FROM wa … ENDLOOP` → `MODIFY dbtab FROM TABLE itab` (review) |
| `SORT` inside a loop (SORT_IN_LOOP) | `"#EC CI_SORTLOOP` | ✅ moved in front of the loop when the loop only reads the table (review) |
| `SELECT … ENDSELECT` left with `EXIT` (SELECT_EXIT) | `"#EC CI_EXIT_SELECT` | ✅ `UP TO 1 ROWS` when the `EXIT` is unconditional |
| `CHECK` right after `SELECT` (SELECT_THEN_CHECK) | `"#EC CI_CHECK` | |
| `FOR ALL ENTRIES` without checking that the table has rows (FOR_ALL_ENTRIES) | `"#EC CI_FAE_LINES_ENSURED` | ✅ wrapped in `IF itab IS NOT INITIAL … ENDIF` with its sy-subrc check (review) |
| `UPDATE … SET` / `DELETE FROM` without `WHERE` (IMUD_TAW_A) | `"#EC CI_NOWHERE` | |
| Critical statements (CRITICAL_STATEMENTS): `EXEC SQL`, `CALL '…'`, `SYSTEM-CALL`, `GENERATE SUBROUTINE POOL`, `INSERT` / `DELETE REPORT`, `READ REPORT`, `EDITOR-CALL`, `ROLLBACK WORK` | `"#EC CI_EXECSQL`, `CI_CCALL`, `CI_SYSTEMCALL`, `CI_GENERATE`, `CI_TABL_EXCEPTN`, `CI_READ_REP`, `CI_EDITORCALL`, `CI_ROLLBACK` | |
| `LOOP AT … INTO` + `MODIFY … FROM` the work area (LOOP_AT) | `"#EC CI_LOOP_INTO_WA` | |
| Interface method called inside a loop (INTFMETHS_IN_LOOP) | `"#EC CI_INTF_LOOP` | |

Run **Show Rules** for each rule's id and exact trigger conditions.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `abap-smartfix.fixMode` | `auto` | `auto`: apply only rewrites with identical semantics, annotate the rest; `rewrite`: also apply rewrites that need review; `suppress`: only add annotations |
| `abap-smartfix.ruleFixModes` | `{}` | Fix mode per rule, overriding `fixMode` |
| `abap-smartfix.suppressStyle` | `rule` | When a rule has both forms, always use `pragma` or `pseudo` |
| `abap-smartfix.abapRelease` | `latest` | ABAP release of the target system; below `7.54`, `ADD a TO b` becomes `b = b + a` instead of `b += a` |
| `abap-smartfix.disabledRules` | `[]` | Rule ids to disable |
| `abap-smartfix.enabledRules` | `[]` | Rule ids to enable that are off by default |
| `abap-smartfix.tokenOverrides` | `{}` | Use the annotation names of your own system |
| `abap-smartfix.verifyFixes` | `true` | Self-check every rewrite before applying it |
| `abap-smartfix.subrcLookahead` | `3` | How many statements after a statement that sets `sy-subrc` may evaluate it (after `ENDSELECT` for `SELECT … ENDSELECT`) |
| `abap-smartfix.selectSingleCheck` | `certain` | Which `SELECT SINGLE` statements are reported and rewritten: `certain` (only those clearly without the full key) or `all` (every one, since the key is unknown without DDIC) |
| `abap-smartfix.diagnosticSeverity` | `information` | Severity in the Problems panel; `auto` uses each rule's own |
| `abap-smartfix.scanOnSave` / `scanOnOpen` | `true` / `false` | Analyze automatically on save / on open |
| `abap-smartfix.scanOnType` | `true` | Analyze an already analyzed file again about 0.5 s after typing stops |
| `abap-smartfix.include` / `exclude` / `maxFiles` | `**/*.abap` / `**/node_modules/**` / `500` | Scope and file limit for analyzing the workspace |
| `abap-smartfix.fileExtensions` | `[".abap"]` | File extensions treated as ABAP (besides files whose language is ABAP) |
| `abap-smartfix.promptIncludeSource` | `true` | Include the numbered source in the AI prompt |
| `abap-smartfix.customRulesFile` | `.abap-smartfix-rules.json` | Custom rules file |

Example:

```jsonc
{
  "abap-smartfix.suppressStyle": "pragma",
  "abap-smartfix.ruleFixModes": { "select-single": "suppress" },
  "abap-smartfix.disabledRules": ["select-no-order-by"]
}
```

### Custom rules

Put a `.abap-smartfix-rules.json` in the workspace root to add annotation or rewrite rules:

```json
[
  {
    "id": "commit-work",
    "token": "\"#EC CI_COMMIT",
    "title": "COMMIT WORK",
    "match": "^COMMIT\\s+WORK\\b"
  },
  {
    "id": "translate-upper",
    "title": "TRANSLATE … TO UPPER CASE → to_upper( )",
    "match": "^TRANSLATE\\s+(\\S+)\\s+TO\\s+UPPER\\s+CASE$",
    "replace": "$1 = to_upper( $1 )"
  }
]
```

`match` is tested against a single statement (multi-line statements are joined and comments removed). A `token` starting with `##` is a Pragma; anything else is a Pseudo Comment.
`"#EC CI_COMMIT` above is only an example: use the name your ATC check really accepts (see the check's messages in transaction SCI).
`replace` can use `$1`, `$2`. Other fields: `notMatch`, `flags`, `why`, `severity`, `safety` (`safe` / `review`), `enabled`.

## Known issues

- This is a lightweight syntax scanner, not a full ABAP parser. It cannot see macro expansion, `INCLUDE` chains, cross-program calls or DDIC information.
- Accepted annotation names can differ between SAP releases and custom ATC checks. Go by the messages in your system and adjust with `abap-smartfix.tokenOverrides` if needed.
- `##NEEDED` only looks at the current file. Global declarations in TOP includes are skipped to avoid flagging variables used in other includes or dynpros.
- Annotations only make ATC skip a check; they do not improve the code. Real problems (such as a `SELECT` inside a loop) are better fixed in code.

If you find a false positive or a missed finding, please report it with a minimal code sample.

## Trademarks

SAP, ABAP and other SAP products and services mentioned herein are trademarks or registered trademarks of SAP SE in Germany and other countries. ABAP SmartFix is an independent project and is not affiliated with, endorsed by or sponsored by SAP SE.

## License

MIT. See the LICENSE file included with the extension.
