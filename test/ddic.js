'use strict';

/**
 * Tests of the DDIC lookups (src/ddic.js, src/ddic-adt.js).
 * The DDIC objects below are invented (ZSF_DEMO_*), in the form ABAP Development Tools for VS Code returns them.
 *
 *   $env:ELECTRON_RUN_AS_NODE=1
 *   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" test\ddic.js
 */

const Module = require('module');
const { analyze } = require('../src/analyzer');
const DD = require('../src/ddic');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

// A table (<name>.tabl.ddic): key fields, a foreign key, a non-key include
const MATERIAL_TABL = [
  "@EndUserText.label : 'Material (test fixture)'",
  '@AbapCatalog.tableCategory : #TRANSPARENT',
  '@AbapCatalog.deliveryClass : #A',
  'define table zsf_demo_material {',
  '',
  '  @AbapCatalog.foreignKey.keyType : #KEY',
  '  @AbapCatalog.foreignKey.screenCheck : true',
  '  key mandt : mandt not null',
  '    with foreign key [0..*,1] zsf_demo_client',
  '      where mandt = zsf_demo_material.mandt;',
  '  key matnr : matnr not null;',
  '  include zsf_demo_material_data;',
  '  ersda     : ersda;',
  '  @AbapCatalog.foreignKey.keyType : #KEY',
  '  mtart     : mtart',
  '    with foreign key [0..*,1] zsf_demo_mtype',
  '      where mandt = zsf_demo_material.mandt',
  '        and mtart = zsf_demo_material.mtart;',
  '  matkl     : matkl;',
  '  meins     : meins;',
  '',
  '}',
].join('\n');
// A structure (also <name>.tabl.ddic)
const RESULT_TABL = [
  "@EndUserText.label : 'Result row (test fixture)'",
  'define structure zsf_demo_result {',
  '',
  '  objtype : zsf_demo_type;',
  '  objname : zsf_demo_name;',
  '  code    : zsf_demo_code;',
  "  @EndUserText.label : 'Details'",
  '  detail  : abap.rawstring(0);',
  '',
  '}',
].join('\n');
// A table type (<name>.ttypda.jsonc: table types have no source view in ADT for VS Code)
const RET_TTYP = [
  '// Table type metadata in the form ABAP Development Tools for VS Code returns it (written for the tests)',
  '// adt://DEV/sap/bc/adt/ddic/tabletypes/zsf_demo_ret_t',
  '{',
  '  "name": "ZSF_DEMO_RET_T",',
  '  "type": "TTYP/DA",',
  '  "description": "Return table",',
  '  "abapLanguageVersion": "standard"',
  '}',
].join('\n');

// ------------------------------------------------------------------ parsing
console.log('\n== Parsing ==');
const material = DD.parseTabl(MATERIAL_TABL);
check('table with key MANDT, MATNR (foreign keys and includes are not key fields)',
  material.category === 'table' && material.keys.join() === 'MANDT,MATNR' && material.clientKey === 'MANDT' && material.keysComplete, JSON.stringify(material));
check('the column names are read (MANDT, MATNR first)', material.fields.slice(0, 2).join() === 'MANDT,MATNR' && material.fields.length === material.fieldCount,
  material.fields.slice(0, 5).join());
const struct = DD.parseTabl(RESULT_TABL);
check('structure', struct.category === 'structure', JSON.stringify(struct));
check('table type', (DD.parseTtyp(RET_TTYP) || {}).category === 'tabletype');
check('placeholder without description (ADT answers any <name>.ttypda.jsonc): not a table type',
  DD.parseTtyp('{ "name": "MATNR", "type": "TTYP/DA" }', 'MATNR') === null);
check('table type of another name: not this one', DD.parseTtyp(RET_TTYP, 'MATNR') === null);
check('table definition of another name: not this one', DD.parseTabl(MATERIAL_TABL, 'ZSF_DEMO_PLANT') === null);
check('transaction metadata is not a table type', DD.parseTtyp('{ "name": "ZSF_DEMO_TCODE", "type": "TRAN/T" }') === null);
check('key include: keys not complete', DD.parseTabl('define table z {\n  key include zkey;\n  key f : c;\n}').keysComplete === false);
check('not a table definition', DD.parseTabl('<html>') === null);
check('equality fields: alias~field, EQ, literals; OR parts and ranges are not "="',
  [...DD.equalityFields("SELECT SINGLE * FROM ZSF_DEMO_STOCK AS A WHERE A~MATNR = @LV AND WERKS EQ '1000' AND LGORT > 'X' INTO @DATA(LS)")].sort().join() === 'MATNR,WERKS');

const req = DD.ddicRequests([
  'CLASS lcl DEFINITION.',
  '  PUBLIC SECTION.',
  '    TYPES tty_local TYPE STANDARD TABLE OF zsf_demo_material WITH EMPTY KEY.',
  '    METHODS a EXPORTING VALUE(et) TYPE zsf_demo_ret_t RETURNING VALUE(rt) TYPE zret_t.',
  '    METHODS b IMPORTING VALUE(it) TYPE tty_local VALUE(iv) TYPE i VALUE(ic) TYPE zcl_x=>tty.',
  'ENDCLASS.',
  'START-OF-SELECTION.',
  '  SELECT SINGLE labst FROM zsf_demo_stock INTO @DATA(lv) WHERE matnr = @gv.',
  '  SELECT SINGLE a~matnr FROM zsf_demo_material AS a INNER JOIN zsf_demo_plant AS c ON c~matnr = a~matnr INTO @DATA(lv2) WHERE a~matnr = @gv.',
].join('\n'));
check('requests: DDIC types of VALUE parameters only (not RETURNING, local, built-in or class types)', req.types.join() === 'ZSF_DEMO_RET_T', JSON.stringify(req));
check('requests: tables of SELECT SINGLE, also of each JOIN table', req.tables.join() === 'ZSF_DEMO_STOCK,ZSF_DEMO_MATERIAL,ZSF_DEMO_PLANT', JSON.stringify(req));

// ------------------------------------------------------------------ rules with and without DDIC
console.log('\n== Rules ==');
const ddic = DD.viewOf(new Map([
  ['ZSF_DEMO_MATERIAL', material],
  ['ZSF_DEMO_STOCK', DD.parseTabl('define table zsf_demo_stock {\n  key mandt : mandt not null;\n  key matnr : matnr not null;\n  key werks : werks_d not null;\n  key lgort : lgort_d not null;\n}')],
  ['ZSF_DEMO_RET_T', { category: 'tabletype' }],
  ['ZSF_DEMO_RESULT', struct],
  ['ZNOTHING', null],
]));
const src = [
  'CLASS lcl DEFINITION.',
  '  PUBLIC SECTION.',
  '    METHODS get_ret EXPORTING VALUE(rt_ret) TYPE zsf_demo_ret_t.',
  '    METHODS get_row EXPORTING VALUE(rs_row) TYPE zsf_demo_result.',
  'ENDCLASS.',
  'CLASS lcl IMPLEMENTATION.',
  '  METHOD get_ret.',
  '    CLEAR rt_ret.',
  '  ENDMETHOD.',
  '  METHOD get_row.',
  '    CLEAR rs_row.',
  '  ENDMETHOD.',
  'ENDCLASS.',
  'START-OF-SELECTION.',
  '  SELECT SINGLE labst FROM zsf_demo_stock INTO @DATA(lv_a) WHERE matnr = @gv_matnr AND werks = @gv_werks.',
  '  IF sy-subrc = 0. ENDIF.',
  '  SELECT SINGLE mtart FROM zsf_demo_material INTO @DATA(lv_b) WHERE matnr = @gv_matnr.',
  '  IF sy-subrc = 0. ENDIF.',
  '  SELECT SINGLE labst FROM zsf_demo_stock INTO @DATA(lv_c) WHERE mandt = @sy-mandt AND matnr = @gv_matnr AND werks = @gv_werks AND lgort = @gv_lgort.',
  '  IF sy-subrc = 0. ENDIF.',
  '',
].join('\n');
const at = (r, line, id) => r.findings.filter((f) => f.startLine + 1 === line && f.ruleId === id);
const plain = analyze(src, {});
const withDd = analyze(src, { ddic });

check('without DDIC: EXPORTING VALUE( ) DDIC table type not used as a table is not reported', at(plain, 7, 'value-param-table').length === 0);
check('with DDIC: EXPORTING VALUE( ) TYPE zsf_demo_ret_t → "#EC CI_VALPAR', at(withDd, 7, 'value-param-table').length === 1);
check('with DDIC: EXPORTING VALUE( ) structure is not reported', at(withDd, 10, 'value-param-table').length === 0);
check('without DDIC: SELECT SINGLE with only = conditions is not reported', at(plain, 15, 'select-single').length === 0);
const ss = at(withDd, 15, 'select-single');
check('with DDIC: SELECT SINGLE on ZSF_DEMO_STOCK without LGORT is reported, with the missing key field',
  ss.length === 1 && ss[0].detail === 'key fields not in the WHERE: lgort', JSON.stringify(ss.map((f) => f.detail)));
check('with DDIC: full key of ZSF_DEMO_MATERIAL (client field not needed): not reported', at(withDd, 17, 'select-single').length === 0);
check('with DDIC: full key including MANDT: not reported', at(withDd, 19, 'select-single').length === 0);
check('unknown table (not looked up): source-only behavior', DD.missingKeyFields('SELECT SINGLE F FROM ZUNKNOWN INTO @X WHERE A = 1', ddic) === null);

// ------------------------------------------------------------------ ADT file system (fake vscode)
console.log('\n== ABAP Development Tools for VS Code ==');
const reads = [];
let installed = true;
const files = {
  '/flat/DEV/zsf_demo_material.tabl.ddic': MATERIAL_TABL,
  '/flat/DEV/zsf_demo_ret_t.ttypda.jsonc': RET_TTYP,
  // what ADT may answer for a name that is no table type (data element MATNR)
  '/flat/DEV/matnr.ttypda.jsonc': '// The object is not supported in ABAP development tools for VS Code.\n{\n  "name": "MATNR",\n  "type": "TTYP/DA"\n}',
};
const notFound = () => Object.assign(new Error('FileNotFound'), { code: 'FileNotFound' });
const fakeVscode = {
  extensions: { getExtension: (id) => (installed && id === 'sapse.adt-vscode' ? {} : undefined) },
  Uri: { from: (c) => ({ scheme: c.scheme, path: c.path }) },
  workspace: {
    fs: {
      readFile: async (uri) => {
        reads.push(uri.scheme + ':' + uri.path);
        if (uri.path.indexOf('/flat/OFFLINE/') === 0) throw new Error('Destination OFFLINE is not logged on');
        if (files[uri.path] == null) throw notFound();
        return Buffer.from(files[uri.path], 'utf8');
      },
    },
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? fakeVscode : origLoad.call(this, request, ...rest);
};
const Adt = require('../src/ddic-adt');
Module._load = origLoad;

(async () => {
  check('destination from the ADT repository tree URI',
    Adt.destinationOf({ scheme: 'abap', path: '/repotree-v1/DEV/System Library/ZSF_DEMO/Source Code Library/Programs/ZR/zr.prog.abap' }) === 'DEV');
  check('local files use the configured destination', Adt.destinationOf({ scheme: 'file', path: '/d/x.abap' }, 'DEV') === 'DEV');
  check('namespace names in AFF form', Adt.affName('/SAPAPO/MATKEY') === '(sapapo)matkey');

  const learned = await Adt.prefetch('DEV', ['ZSF_DEMO_MATERIAL', 'zsf_demo_ret_t', 'ZNOPE'], null);
  const view = Adt.viewFor('DEV');
  check('reads abap:/flat/<destination>/<name>.tabl.ddic, then .ttypda.jsonc',
    reads.indexOf('abap:/flat/DEV/zsf_demo_material.tabl.ddic') >= 0 && reads.indexOf('abap:/flat/DEV/zsf_demo_ret_t.ttypda.jsonc') >= 0, reads.join());
  check('table, table type and a name that is neither are cached', learned === 3 &&
    view.get('zsf_demo_material').keys.join() === 'MANDT,MATNR' && view.get('ZSF_DEMO_RET_T').category === 'tabletype' && view.get('ZNOPE') === null);
  await Adt.prefetch('DEV', ['MATNR'], null);
  check('data element MATNR is not taken for a table type (ADT placeholder without description)', Adt.viewFor('DEV').get('MATNR') === null);
  const ctor = analyze([
    'CLASS lcl DEFINITION.', '  PUBLIC SECTION.',
    '    METHODS constructor IMPORTING VALUE(iv_matnr) TYPE matnr.', 'ENDCLASS.',
    'CLASS lcl IMPLEMENTATION.', '  METHOD constructor.', '    mv_matnr = iv_matnr.', '  ENDMETHOD.', 'ENDCLASS.', '',
  ].join('\n'), { ddic: Adt.viewFor('DEV') });
  check('METHOD constructor with IMPORTING VALUE( ) TYPE matnr gets no "#EC CI_VALPAR', !ctor.findings.some((f) => f.ruleId === 'value-param-table'));
  const before = reads.length;
  check('cached names are not read again', (await Adt.prefetch('DEV', ['ZSF_DEMO_MATERIAL'], null)) === 0 && reads.length === before);
  // The analysis cache of the extension is keyed by cacheSummary: a name learned not to exist changes the findings too
  // (SUBMIT of a program that does not exist), so it must change the summary
  const summaryBefore = Adt.cacheSummary();
  await Adt.prefetch('DEV', ['PROG:ZSF_DEMO_GONE'], null);
  check('a name learned not to exist changes the cache summary', Adt.viewFor('DEV').get('PROG:ZSF_DEMO_GONE') === null &&
    Adt.cacheSummary() !== summaryBefore, summaryBefore + ' / ' + Adt.cacheSummary());

  const logs = [];
  check('not logged on: nothing learned, the name stays unknown',
    (await Adt.prefetch('OFFLINE', ['ZSF_DEMO_MATERIAL'], (m) => logs.push(m))) === 0 && Adt.viewFor('OFFLINE').get('ZSF_DEMO_MATERIAL') === undefined && logs.length > 0);
  const offlineReads = reads.length;
  await Adt.prefetch('OFFLINE', ['ZSF_DEMO_MATERIAL'], null);
  check('a failed name is not asked again right away', reads.length === offlineReads);

  installed = false;
  check('without ABAP Development Tools for VS Code nothing is read', (await Adt.prefetch('DEV', ['ZSF_DEMO_PLANT'], null)) === 0);

  console.log('\n' + (failed === 0 ? 'ALL PASS' : failed + ' FAILED'));
  process.exit(failed === 0 ? 0 : 1);
})();
