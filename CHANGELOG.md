# Changelog

## 1.5.4

- **Preview Fixes** is the main way to fix: it closes the secondary side bar for more room, and has an Auto Fix button that applies the fixes and returns to the file.

## 1.5.3

- **Hover**: hover over a reported line to see why it is reported and how it can be fixed. Turn it off with
  `abap-smartfix.hover`.

## 1.5.2

- **Choose the ATC check variant** with the new setting `abap-smartfix.atc.checkVariant`, or from the sidebar … menu with
  Select ATC Check Variant…. The default `DEFAULT` runs ATC with the system's default check variant, as before.
- With another variant, ABAP Development Tools' "Run ABAP Test Cockpit With..." runs and the variant is picked
  automatically. The name is pasted into its list through the clipboard, and your clipboard text is put back afterwards. If
  the variant cannot be picked, the list stays open with the name filled in, so you can pick it by hand.
- `abap-smartfix.atc.checkVariantDelay` (default 2000 ms) sets how long the list gets to find the variant. Raise it on a slow
  system.
- The sidebar title and the status bar show the check variant when it is not `DEFAULT`.
- After the variant changes, the next Analyze runs ATC again: a result of another variant is not reused.

## 1.5.1

- **Renamed to SmartFix for ABAP.** Commands, settings (`abap-smartfix.*`) and the extension id stay the same.
- The built-in list of buffered tables is gone: buffered tables are known from ATC results of your system (remembered
  automatically) and from `abap-smartfix.bufferedTables`.
- **More ATC findings get their pragma or pseudo comment**, for every SAP check (about 3,100 messages), including `##TEXT_POOL`,
  `##MG_MISSING` and `"#EC CI_ALL_FIELDS_NEEDED`.
- Chained `MOVE: a TO b, c TO d.` is rewritten as one assignment per line.
- `CLIENT SPECIFIED` → `USING CLIENT` and `'EN'` → `'E'` on statements ATC reports are now part of the rules
  `client-specified-obsolete` and `language-literal`: turning a rule off in `disabledRules` also stops these fixes, and
  `ruleFixModes` uses the rule id.
- Faster with large ATC results.
- **Fixed**: string templates spanning several lines, and typing `DATA: a,` at the end of a file, broke the analysis.
- **Fixed**: some findings needed a second fix run, one ATC message got the wrong title, and custom rules with the flag `g` missed
  statements.
- **Fixed**: backticks or `|` in the code could break the AI prompt and the report.
- **Fixed**: a rewrite of a finding only ATC reported (for example `'EN'` in a customer table) was rejected by the self-check and
  left for a manual fix.
- **Fixed**: `SUBMIT` of a program that does not exist was only reported after the next edit, once the DDIC lookup had finished.
- **Fixed**: other syntax check messages with the code GXD were taken for a language literal.
- **Fixed**: a pragma, pseudo comment or rewrite could make a line longer than 255 characters, which ABAP rejects. A pragma now
  goes to the next line, or the statement is broken before a clause keyword; when no break makes room, the fix is left for a
  manual fix with the reason.
- **Fixed**: `"#EC CI_EXECSQL` was written after `EXEC SQL.`, where it has no effect. `EXEC SQL … ENDEXEC` is one statement, so
  it now goes after `ENDEXEC.`, and one found after `EXEC SQL.` is moved there.

## 1.5.0

- **Runs ATC in your SAP system through ABAP Development Tools for VS Code, on by default.** Before a fix, ATC is run and its
  findings are recognized, also without a check class in the result; ABAP SmartFix then fixes exactly what ATC reports.
  This now applies to every fix, including fixes from the sidebar and from a selection.
- New fixes for ATC findings: `CLIENT SPECIFIED` → `USING CLIENT`, language keys `'EN'` → `'E'`, the client field in a
  `WHERE`, buffered tables in a JOIN, `SELECT … UP TO … ROWS` without `ORDER BY`, and `SUBMIT` of a program that does not exist.
- The sidebar shows the line ATC reports, and repeated identical statements each keep their own finding.
- Large programs no longer freeze VS Code after ATC.
- The diff preview says when there is nothing to change automatically.
- Simpler README.

## 1.4.3

- **DDIC from ADT**: with ABAP Development Tools for VS Code logged on, table keys and table types are read from the system (read-only).
  `SELECT SINGLE` missing a key field is reported, and `VALUE( )` parameters typed with a table type get `"#EC CI_VALPAR`.
  Without ADT, the source alone decides as before. New settings `abap-smartfix.ddic.enabled` / `ddic.destination`, command **Clear DDIC Cache**.
- The ABAP SmartFix commands in the editor context menu now open the findings sidebar.

## 1.4.2

- **Fixed**: unchecking one finding in the sidebar unchecked every finding of the file.
- **Fixed**: **Fix Findings in Selection…** from the editor context menu always reported "No findings in the selected lines".
- **Fixed**: the open diff preview did not follow checkbox changes in the sidebar.
- **Fixed**: the Quick Fix "Auto fix whole file (…)" counted unchecked findings too.
- Opening a finding from the sidebar brings its diff preview back to the front when the diff tab is still open
  but hidden behind another tab, so the original and the preview are shown side by side again.

## 1.4.1

- Republished package; no functional changes.

## 1.4.0

- **Removed**: the **Export JSON** command. Use **Generate Markdown Report** for a summary of the findings.
- README: demo GIF.

## 1.3.0

Every annotation name was checked against the SCI message catalog (`SCIMESSAGES`) of an S/4HANA system. The extension now works in VS Code only: nothing needs to be installed or run in the SAP system.

- **Corrected annotation names** (the old ones did not suppress the finding):
  - `SELECT SINGLE` without the full key: `"#EC CI_NOORDER` (alternative `"#EC WARNOK`), the "SELECT SINGLE is possibly not unique" message of
    the *SELECT without ORDER BY* check, instead of `##WARN_OK`, which no check of that system accepts;
  - `CHECK` after `SELECT`: `"#EC CI_CHECK` (was `CI_CHECK_SELECT`); interface call in a loop: `"#EC CI_INTF_LOOP` (was `CI_INTF_IN_LOOP`);
    `CALL TRANSACTION`: `"#EC CI_CALLTA` (was `CI_CALL_TA`); linear search inside a loop: `"#EC CI_STDSEQ` (was `CI_NESTED`, which is for LOOPs without WHERE);
  - dynamic `WHERE` is now its own rule with `"#EC CI_DYNWHERE` (was `CI_DYNTAB`, the pseudo comment of a dynamic table name);
  - critical statements get the pseudo comment of their message: `CI_EXECSQL`, `CI_CCALL`, `CI_SYSTEMCALL`, `CI_GENERATE`, `CI_TABL_EXCEPTN`,
    and new `CI_READ_REP` (`READ REPORT`), `CI_EDITORCALL`, `CI_ROLLBACK` (`ROLLBACK WORK`); `OPEN DATASET … FILTER` is not a message of that check;
  - `sy-subrc`: the SY-SUBRC check has no pragma, so `##SUBRC_OK` is no longer written with `suppressStyle: pragma`;
  - *SELECT without ORDER BY*: ATC reports it on the statement that uses the result (with `"#EC CI_SORTED`), so the SELECT no longer gets
    `"#EC CI_NOORDER`; the ORDER BY PRIMARY KEY rewrite (review) remains.
- **New check**: `AT NEW` / `AT END OF` / `AT FIRST` / `AT LAST` inside `LOOP … WHERE / FROM / TO`
  (`##LOOP_AT_OK`, extended program check 0201 / 0235).
- **Removed checks** whose result could not be confirmed: `SELECT *` (`CI_ALL_FIELDS_NEEDED` is only reported when few fields are used),
  calls of database routines in loops, `DELETE` after `SELECT`, complex `WHERE`, `SELECT * INTO CORRESPONDING FIELDS`, Oracle hints,
  `STXH` / `STXL` access, RFC callbacks, `AUTHORITY-CHECK … DUMMY`, `APPEND` to `SORTED` tables, `SORT` without `BY`, naming conventions.
  [SCI-COVERAGE.md](SCI-COVERAGE.md) lists each with the reason.
- Obsolete pseudo comments: the SLIN table was checked against the same system; `"#EC WARNOK` is no longer converted to `##WARN_OK`
  (there it is the other pseudo comment of `CI_NOORDER`), nor `ENHOK`, `STRING_OK`, `TEXT_CHAR`; `"#EC NON_UTC` → `##INTENTIONAL_NON_UTC` added.
- A READ / LOOP on a standard table inside a loop is reported once (nested-linear-search), not also by linear-search.
- **Removed**: **Import SCI Catalog…**, `tools/ZSMARTFIX_SCI_MESSAGES.abap` and the settings `sciCatalogFile` / `annotateUnverified`
  (all names are confirmed now; use `tokenOverrides` or **Learn Annotation Names from Workspace** for names of your own).
- `test/sci.js` checks every rule's annotation against the catalog messages (`test/sci-messages.json`).
- `.abap-smartfix-rules.example.json`: the `native-sql` example is gone (`EXEC SQL` is now a built-in check with `"#EC CI_EXECSQL`).
- Settings descriptions no longer suggest `##SUBRC_OK`; the README lists every setting.

## 1.2.0

- **20 new rules** (and dynamic SQL / CLIENT SPECIFIED extended to database changes) for the 25 SCI classes that were not covered yet (see [SCI-COVERAGE.md](SCI-COVERAGE.md)):
  database changes and calls that reach the database inside loops, SORT in loops, SELECT … ENDSELECT with EXIT, CHECK / DELETE right after SELECT,
  FOR ALL ENTRIES without an emptiness check, UPDATE / DELETE without WHERE, dynamic SQL and CLIENT SPECIFIED on database changes,
  complex WHERE, SELECT * INTO CORRESPONDING FIELDS, Oracle hints, STXH / STXL access, RFC callbacks, AUTHORITY-CHECK … DUMMY,
  critical statements, APPEND to SORTED tables, LOOP … INTO + MODIFY, nested linear searches, interface calls in loops,
  and naming conventions (off by default). 47 of the 317 classes of the reference system are now covered fully or partly.
- New rewrites, each touching only the words it must: `LOOP … MODIFY dbtab FROM wa … ENDLOOP` → `MODIFY dbtab FROM TABLE itab`,
  SORT moved in front of a loop, `SELECT … EXIT … ENDSELECT` → `UP TO 1 ROWS`, `IF itab IS NOT INITIAL` around FOR ALL ENTRIES,
  Oracle hints removed, `APPEND` → `INSERT … INTO TABLE` for sorted tables. The ones that change behavior are "review" only.
- **Verified annotation names**: every rule knows its SCI class and how sure its annotation name is. Unconfirmed names are no longer written
  into the code (setting `abap-smartfix.annotateUnverified` to allow it). Confirm them with:
  - **Import SCI Catalog…**: the message catalog of your system, downloaded by `tools/ZSMARTFIX_SCI_MESSAGES.abap` (new *Download JSON* option);
  - **Learn Annotation Names from Workspace**: the names your code already uses on the reported statements;
  - `abap-smartfix.tokenOverrides`.
  **Show Rules** shows the status and the SCI classes of every rule.
- **Self-check of rewrites** (`abap-smartfix.verifyFixes`, on by default): each rewrite is applied in memory and analyzed again; if the block structure
  changes or the finding stays, it falls back to an annotation or a manual fix and the reason is logged.
- Findings explain their context (the loop they are in, the routine that accesses the database, the FOR ALL ENTRIES driver table …).
- `tools/sci-coverage.js` generates SCI-COVERAGE.md from the rules.

## 1.1.0

- **Choose what to fix in the sidebar**: every finding has a checkbox; unchecked findings are left out of every auto fix
  (file, all files, preview, fix on save) and stay unchecked when the file is analyzed again. Checking a file checks all its findings;
  **Check All Findings** / **Uncheck All Findings** are in the view's `…` menu, and the wand button fixes a single finding.
- **Fix Findings in Selection…**: select lines in the editor (context menu or `Ctrl+.`) and pick which of their findings to fix.
- Rewrites aligned with [SAP/abap-cleaner](https://github.com/SAP/abap-cleaner):
  - `ADD` / `SUBTRACT` / `MULTIPLY` / `DIVIDE` → `+=` / `-=` / `*=` / `/=`, also with expressions; new setting `abap-smartfix.abapRelease`
    (below 7.54: `b = b + a`, with parentheses around expressions).
  - `MOVE a ?TO b` → `b ?= a`; `MOVE` with a functional call or expression as the source.
  - `CALL METHOD m … RECEIVING r = x` → `x = m( … )`.
  - `CREATE OBJECT` is not rewritten when the target is read in its own parameter list.
  - `DESCRIBE TABLE … LINES` is not rewritten when the block evaluates `SY-TFILL` / `SY-TLENG`.
  - Unused declarations: unused local variables are deleted, constants / globals / names used in commented-out code are commented out,
    variables only filled by `MESSAGE … INTO` get `##NEEDED`.
  - Obsolete pseudo comments: the full SLIN table (132 entries) instead of 8; fixes `"#EC ARGCHECKED` → `##ARG_OK` (was `##ARGCHECKED`).
    Only the effective pseudo comment is converted: `"#EC` right after the `"`, code in upper case; a later `#EC` on the same line is plain text,
    and one right after a chain colon is left alone.
- Corrected annotations:
  - `SELECT *` now uses `"#EC CI_ALL_FIELDS_NEEDED` (the pseudo comment of "Search problematic SELECT * statements"); `CI_NOFIELD` belongs to the index check
    and did not suppress this finding. Statements annotated with `"#EC CI_NOFIELD` by 1.0.0 are listed again.
  - `BREAK-POINT` now gets `##NO_BREAK` (`"#EC NOBREAK` is still accepted).
  - `SORT` without `BY` no longer adds `"#EC CI_SORTSEQ`, which is the pseudo comment for sequential access to SORTED tables; the rule is now an optional hint, off by default.
- [SCI-COVERAGE.md](SCI-COVERAGE.md): coverage of the SCI check classes, and `tools/ZSMARTFIX_SCI_MESSAGES.abap`, a report that lists each check class's
  message codes, pseudo comments and pragmas so the annotation names can be verified in your own system.
- Requires VS Code 1.80 or later (tree view checkboxes).

## 1.0.0

First release of **ABAP SmartFix**.

- Lists SAP ABAP ATC / Code Inspector findings in the Problems panel, a sidebar grouped by file, and the status bar,
  updated when typing pauses and cleared when the file is closed.
- **Auto fix**: applies safe code rewrites and adds the Pragma (`##…`) or Pseudo Comment (`"#EC …`) for the rest, with a confirmation and a diff preview.
  - `SELECT SINGLE` without the full primary key → `SELECT … UP TO 1 ROWS … ENDSELECT` (classic and new syntax).
  - Obsolete syntax: `MOVE`, `MOVE EXACT`, `ADD` / `SUBTRACT` / `MULTIPLY` / `DIVIDE`, `COMPUTE`, `REFRESH`, `DESCRIBE TABLE … LINES`, `CALL METHOD`, `CREATE OBJECT`, `GET REFERENCE OF`.
  - Obsolete pseudo comments to pragmas: `"#EC NEEDED` → `##NEEDED`, `"#EC NOTEXT` → `##NO_TEXT`, and more.
  - Commenting out `BREAK-POINT`; adding `ORDER BY PRIMARY KEY` and commenting out unused declarations (review required).
- Follows the SAP rule of one pseudo comment per line: several pseudo comments are spread over the lines of a statement, breaking it before a clause when needed.
- 17 built-in checks, including `CI_SUBRC`, `CI_NOFIELD`, `CI_NOORDER`, `##WARN_OK`, `CI_NOWHERE`, `CI_SEL_NESTED`, `CI_DYNTAB`, `CI_STDSEQ`, `##NEEDED` and `##NO_TEXT`, tuned to avoid false positives
  (e.g. `SELECT-OPTIONS`, internal table operations, `SORTED` / `HASHED` tables, TOP include globals).
- Quick Fix per finding with both the rewrite and the annotation, plus `source.fixAll.abap-smartfix` for auto fix on save.
- Suppress-only mode, per-rule fix modes, and a choice between pragma and pseudo comment style.
- Fix a whole workspace in a single undoable edit.
- AI prompt with hard rules, a per-line table, rewrite details and numbered source; Markdown report.
- Custom rules (`.abap-smartfix-rules.json`) for annotations and regex rewrites.
