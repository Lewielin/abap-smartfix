# Development

For maintainers; not packaged into the `.vsix`. For usage, see [README.md](README.md).

The extension is plain JavaScript: no build step, no dependencies, and Node.js is optional (VS Code's own runtime runs the tests).

## Run from source

Link the folder into the VS Code extensions folder, then run **Developer: Reload Window** after each change:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.vscode\extensions\abap-smartfix" -Target "<path to the source folder>"
```

## Test

```powershell
$env:ELECTRON_RUN_AS_NODE=1
$code = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
foreach ($t in 'run', 'loadtest', 'sci', 'ddic', 'atc') { & $code "test\$t.js" }   # each ends with ALL PASS
& $code tools\sci-coverage.js   # after changing rules: regenerates SCI-COVERAGE.md
& $code tools\check-adt-atc-api.js   # after ADT for VS Code is updated: can the ATC check variant be passed directly now?
```

| Test | Covers |
| --- | --- |
| `test/run.js` | statement splitting, rules, where annotations go, rewrites, idempotence, AI prompt / report |
| `test/loadtest.js` | the extension with a fake `vscode` module (writes a sample prompt to `test/prompt-preview.md`) |
| `test/sci.js` | the SCI checks, annotation names against the catalog, learning names, the self-check of rewrites |
| `test/ddic.js` | table / table type files from ADT and the rules that use them |
| `test/atc.js` | matching an ATC result, as ADT for VS Code publishes it, to the findings |

The samples in `samples/` are the scenarios the tests and the demo use (`false-positive.abap`: valid code that must not be reported).

## Package and release

```powershell
.\tools\build-vsix.ps1   # PowerShell only; src/*.js is picked up automatically, other files are listed in $files
```

For a release: `version` in `package.json` with a section at the top of `CHANGELOG.md`, all tests pass, then build, install the
`.vsix` (**Extensions: Install from VSIX…**) and analyze `samples/demo.abap` once.

## Source layout

| File | Role |
| --- | --- |
| `src/extension.js` | VS Code integration: commands, diagnostics, Quick Fix, status bar, sidebar checkboxes |
| `src/atc-runner.js` | runs ATC through ADT for VS Code (also with a check variant), the ATC result per document, buffered tables remembered per system |
| `src/preview.js` | the diff preview (original ↔ fixed) and its content provider |
| `src/hover.js` | hover on a reported statement: why, and the ways to fix it |
| `src/lexer.js` | statement splitter: literals, string templates, comments, chained statements, positions |
| `src/analyzer.js` | applies the rules and decides rewrite / annotation / manual per finding |
| `src/finding.js` | what source and ATC findings share: rule registry, enabled rules, fix mode → action / label, location |
| `src/rules.js`, `src/rules-sci.js` | the rules: which SCI check (`sci.classes`, `sci.text`), annotation, rewrite (`atcFix`: of what ATC reports), explanation |
| `src/rewrites*.js` | code rewrites that touch only the words they must (`rewrites-atc.js`: for syntax check warnings) |
| `src/fixer.js` | turns findings into edits: pragma before the terminator, one pseudo comment per line, conflicts |
| `src/verify.js` | self-check: each rewrite is applied in memory and analyzed again before it may touch the file |
| `src/atc.js` | matches the ATC result of ADT for VS Code to the findings; annotations of ATC messages, rewrites through the rules' `atcFix` |
| `src/sci-catalog.js`, `src/sci-messages.js` | the annotation of each SCI message (see **SAP data** below) |
| `src/ddic.js`, `src/ddic-adt.js` | table keys and table types, read-only through ADT for VS Code |
| `src/pseudo-pragmas.js` | obsolete SLIN pseudo comments and their pragmas (from SAP abap-cleaner, Apache-2.0, see LICENSE) |
| `src/syntax.js`, `src/structure.js` | shared syntax checks and loop ranges |
| `src/learn.js`, `src/selection.js`, `src/report.js`, `src/view.js` | learning names, sidebar checkboxes, AI prompt / report, sidebar |

## SAP data

- `src/sci-messages.js`: the annotations of an S/4HANA reference system **by check class and message code only**, without message texts.
- `src/sci-catalog.js`: messages seen in ATC results that the reference system does not list (SLIN, syntax check, ADT's own message
  ids). They are recognized by a short pattern you write yourself (`match`), never by a copy of the SAP message. Add one here when ATC
  reports a message the catalog does not know.
- Buffered tables are not shipped: the tables ATC reports as buffered are remembered per system in VS Code (`globalState`), plus
  the setting `abap-smartfix.bufferedTables`.
- Never commit content copied from an SAP system (message texts, table definitions, source code, exports): write test fixtures
  (such as the DDIC objects in `test/ddic.js`) yourself, and use invented names (`Z_SMARTFIX_*`, `ZSF_DEMO_*`) and the destination
  `DEV`. `.gitignore` keeps `*.vsix` and spreadsheet exports out.

## Principles

- **Start from the ATC finding**: a rule stands for an SCI check class and the message it reports.
- **Never write a guessed name into customer code**: an annotation comes from the catalog; a check whose name, position or limits
  cannot be confirmed is left out (SCI-COVERAGE.md). An ATC message code that several check classes use differently is not guessed.
- **Nothing is installed in the SAP system**: ATC runs through ADT for VS Code, and DDIC objects are only read. Without ADT, the
  rules decide from the source.
- **Minimal changes**: a rewrite never re-indents and keeps comments; one that can change behavior is `safety: 'review'` and only
  applied in `fixMode: rewrite` or from the Quick Fix.
- **Explain**: `detail(s, ctx)` says why this statement is reported.

## Icons

`media/icon.png` (256×256) is exported from `media/icon-source.svg`; `media/icon.svg` is the single-color Activity Bar icon. After
editing the source, export the PNG again:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --default-background-color=00000000 `
  --window-size=256,256 --screenshot="$PWD\media\icon.png" "file:///$($PWD -replace '\\','/')/media/icon-source.svg"
```

## Next steps

1. Secondary indexes and buffering from the DDIC, and abapGit `*.tabl.xml` as a source without ADT.
2. Follow `INCLUDE` and calls across the files of the workspace.
3. Report annotations whose finding no longer exists.
4. Rank findings by impact (loop depth, table size).
