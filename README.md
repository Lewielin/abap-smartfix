# SmartFix for ABAP

Auto fix ATC findings, pragmas and modern syntax for SAP ABAP in VS Code.

![SmartFix for ABAP demo](https://raw.githubusercontent.com/Lewielin/abap-smartfix/main/media/demo.gif)

SmartFix for ABAP finds ATC and Code Inspector findings in your ABAP code and:

- rewrites the code where a safe fix exists, for example `MOVE a TO b` → `b = a`
- adds the right pragma (`##…`) or pseudo comment (`"#EC …`) for the rest
- marks what must be fixed by hand, and can copy a prompt for your AI assistant

## ATC in your SAP system

With ABAP Development Tools for VS Code, SmartFix for ABAP runs ATC in your SAP system first and fixes exactly what ATC reports. This is on by default and can be switched off in the sidebar `…` menu.

Files not opened from ADT, such as abapGit `.abap` files, are checked from the source code instead.

## Requirements

- VS Code 1.80 or later
- Recommended: ABAP Development Tools for VS Code, logged on to your SAP system
- Nothing to install in the SAP system

## Getting started

1. Open an ABAP program, class or include.
2. Right-click in the editor and choose SmartFix for ABAP: Analyze Current File.
3. Review the findings in the SmartFix for ABAP sidebar. Uncheck the ones you want to skip.
4. Fix them:

| To do this | Use |
| --- | --- |
| See the changes first | Preview Fixes |
| Fix everything checked | Auto Fix Current File |
| Only add pragmas and pseudo comments | Add Pragmas & Pseudo Comments Only |
| Fix one line | `Ctrl+.` on the line |
| Fix some lines | Select them, right-click, Fix Findings in Selection… |
| Ask an AI assistant | Copy AI Prompt |

Hover over a reported line to see why it is reported and how it can be fixed (`abap-smartfix.hover` turns this off).

One `Ctrl+Z` undoes a whole fix. Files are not saved automatically. After fixing, save and run ATC again to confirm.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `abap-smartfix.atc.enabled` | `true` | Run ATC in the SAP system and fix what it reports |
| `abap-smartfix.atc.checkVariant` | `DEFAULT` | ATC check variant; `DEFAULT` is the system's default |
| `abap-smartfix.fixMode` | `auto` | `auto`, `rewrite` (also rewrites that need review) or `suppress` (annotations only) |
| `abap-smartfix.suppressStyle` | `rule` | Prefer `pragma` or `pseudo` comments |
| `abap-smartfix.disabledRules` | `[]` | Rules to turn off |
| `abap-smartfix.tokenOverrides` | `{}` | Annotation names of your own system |
| `abap-smartfix.bufferedTables` | `[]` | Buffered tables to know without ATC (the ones ATC reports are remembered) |

Run SmartFix for ABAP: Show Rules to see every rule.

## Known limits

- One file at a time; includes and called programs are not followed.
- Without ATC, a `JOIN` with a buffered table is only found for tables ATC has reported before or that you list in `bufferedTables`.
- Annotations only hide a finding. Real problems, such as a `SELECT` in a loop, are better fixed in the code.

## Privacy

SmartFix for ABAP runs inside VS Code and sends no code or data anywhere. ATC and dictionary lookups go through ABAP Development Tools to your own SAP system. The AI prompt is only copied to your clipboard when you ask for it.

## Trademarks

SAP and ABAP are trademarks or registered trademarks of SAP SE. SmartFix for ABAP is not affiliated with or endorsed by SAP SE.

## License

MIT License © 2026 Lewie Lin. See LICENSE, which also includes the notice for the part taken from SAP abap-cleaner (Apache License 2.0).
