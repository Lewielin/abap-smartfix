'use strict';

/**
 * SCI message catalog, used like CL_CI_TEST_ROOT->GET_MESSAGE_PCOMS: an ATC finding gives the annotation that suppresses it,
 * also for messages no rule stands for. pcom NOX / CI_TABL_EXCEPTN: cannot be suppressed in the code.
 *
 * First the messages seen in ATC results of a development system, recognized by a short part of their text (match): SLIN and
 * syntax check messages are not in SCIMESSAGES, ADT for VS Code reports its own message ids and often no check class, and
 * where such an entry has the same message as the reference system, it comes first and wins. Then the annotations of the
 * reference system by check class and message code (sci-messages.js), without message texts.
 */
const e = (clsname, code, pcom, pcom_alt, pragma, match) => ({ clsname, code, pcom, pcom_alt, pragma, match });

const SEEN_IN_ATC = [
  e('CL_CI_TEST_VALUE_PARAMETER', '', 'CI_VALPAR', '', '', /internal table and is passed by VALUE/i),
  e('CL_CI_TEST_ANALYZE_SELECT_DIA', '', 'CI_ALL_FIELDS_NEEDED', '', '', /^Existence check\b/i),
  e('CL_CI_TEST_ANALYZE_SELECT_DIA', '', 'CI_ALL_FIELDS_NEEDED', '', '', /can be transformed.*% of fields used/i),
  e('CL_CI_TEST_SELECT_TAW_BYBUF', '', 'CI_BUFFJOIN', '', '', /^Buffered table \S+ in a JOIN/i),
  e('CL_CI_TEST_SELECT_TAW_BYBUF', '', 'CI_GENBUFF', 'CI_SGLSELECT', '', /Generically buffered key range not fully specified/i),
  e('CL_CI_TEST_ANALYZE_SELECT_DIA', 'EXISTS', 'CI_ALL_FIELDS_NEEDED', '', '', /^Existence check\b/i),
  e('CL_CI_TEST_ANALYZE_SELECT_DIA', 'FEW', 'CI_ALL_FIELDS_NEEDED', '', '', /can be transformed.*% of fields used/i),
  e('CL_CI_TEST_SELECT_TAW_BYBUF', '0005', 'CI_GENBUFF', 'CI_SGLSELECT', '', /Generically buffered key range not fully specified/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '1007', '', '', 'FM_SUBRC_OK', /SY-SUBRC.*EXCEPTION addition is not processed/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '1809', '', '', 'NEEDED', /called by SUBMIT .* does not exist/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '1700', 'NOTEXT', '', 'NO_TEXT', /^Strings without text elements/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '0600', '', '', 'MG_MISSING', /^The message .* in the message class .* does not exist/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '0601', '', '', 'MG_MISSING', /specified using WITH for the message class/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '1701', '', '', 'TEXT_POOL', /text symbol .* not defined in the text pool/i),
  e('CL_CI_TEST_ANALYZE_SELECT_DIA', 'UNCLEAR', 'CI_ALL_FIELDS_NEEDED', '', '', /^Incomplete evaluation\b.*% of fields used/i),
  // Syntax check warnings: no annotation suppresses them (rewritten by rewrites-atc.js or rules.js)
  e('CL_CI_TEST_SYNTAX_CHECK', 'W247', 'NOX', '', '', /MESSAGE GGC\b/i),
  e('CL_CI_TEST_SYNTAX_CHECK', 'W126', 'NOX', '', '', /MESSAGE GYA\b/i),
  e('CL_CI_TEST_SYNTAX_CHECK', 'W251', 'NOX', '', '', /MESSAGE GXD\b/i),
  e('CL_CI_TEST_SELECT_TAW_BYBUF', '0051', 'CI_SGLSELECT', 'CI_GENBUFF', '', /single record buffered table .* cannot use buffer/i),
  e('CL_CI_TEST_SELECT_TAW_BYBUF', '0006', 'CI_BUFFCLIENT', '', '', /client-specific table .* CLIENT SPECIFIED, but no client field/i),
  e('CL_CI_TEST_EXTENDED_CHECK', '', '', '', 'BOOL_OK', /is not a valid comparison value/i),
  e('CL_CI_TEST_ANALYZE_SELECT_DIA', '', 'CI_NO_TRANSFORM', '', '', /FOR ALL statement can be joined with SELECT/i),
];

module.exports = SEEN_IN_ATC.concat(require('./sci-messages'));
