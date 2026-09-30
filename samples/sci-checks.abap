*&---------------------------------------------------------------------*
*& Report Z_DEMO_SCI_CHECKS: performance / robustness / security checks
*& Lines marked "ok" must not be reported by the rule named in the comment above them
*&---------------------------------------------------------------------*
REPORT z_demo_sci_checks.

DATA gt_mara TYPE STANDARD TABLE OF mara WITH EMPTY KEY.
DATA gs_mara TYPE mara.
DATA gt_marc TYPE STANDARD TABLE OF marc WITH EMPTY KEY.
DATA gt_log TYPE STANDARD TABLE OF ztab_log WITH EMPTY KEY.
DATA gs_log TYPE ztab_log.
DATA gv_tab TYPE tabname.
DATA gv_where TYPE string.
DATA go_reader TYPE REF TO zif_reader.

START-OF-SELECTION.

* db-change-in-loop: one database call per row (rewritten to the array form)
  LOOP AT gt_log INTO gs_log.
    MODIFY ztab_log FROM gs_log.
  ENDLOOP.

* db-change-in-loop: other statements in the loop, only reported
  LOOP AT gt_log INTO gs_log.
    gs_log-counter = gs_log-counter + 1.
    UPDATE ztab_log FROM gs_log.
  ENDLOOP.

* sort-in-loop: gt_marc is only read in the loop, so SORT moves in front of it
  LOOP AT gt_mara INTO gs_mara.
    SORT gt_marc BY matnr werks.
    READ TABLE gt_marc TRANSPORTING NO FIELDS WITH KEY matnr = gs_mara-matnr BINARY SEARCH.
  ENDLOOP.

* sort-in-loop: the loop appends to the table, so SORT stays (only reported)
  LOOP AT gt_mara INTO gs_mara.
    APPEND INITIAL LINE TO gt_marc.
    SORT gt_marc BY matnr.
  ENDLOOP.

* select-exit: unconditional EXIT at the end → UP TO 1 ROWS
  SELECT matnr FROM mara INTO gs_mara-matnr WHERE mtart = 'FERT'.
    EXIT.
  ENDSELECT.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* select-exit + select-then-check: conditional EXIT, only reported
  SELECT * FROM mara INTO gs_mara WHERE mtart = 'FERT'.
    CHECK gs_mara-matkl = 'A'.
    IF gs_mara-brgew > 10.
      EXIT.
    ENDIF.
  ENDSELECT.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* fae-without-check: no check that gt_mara has rows (wrapped in IF … IS NOT INITIAL)
  SELECT * FROM marc INTO TABLE gt_marc FOR ALL ENTRIES IN gt_mara WHERE matnr = gt_mara-matnr.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* fae-without-check ok: inside IF … IS NOT INITIAL
  IF gt_mara IS NOT INITIAL.
    SELECT * FROM marc INTO TABLE gt_marc FOR ALL ENTRIES IN gt_mara WHERE matnr = gt_mara-matnr.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
  ENDIF.

* fae-without-check ok: IF … IS INITIAL. RETURN. ENDIF. before it
  IF gt_log IS INITIAL.
    RETURN.
  ENDIF.
  SELECT * FROM ztab_log APPENDING TABLE gt_log FOR ALL ENTRIES IN gt_log WHERE id = gt_log-id.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* change-without-where: every row of the table
  UPDATE ztab_log SET counter = 0.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.
  DELETE FROM ztab_log.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* dynamic-sql and client-specified on database changes (IMUD_TAW_SEC01)
  DELETE FROM (gv_tab) CLIENT SPECIFIED WHERE mandt = sy-mandt.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* dynamic-where (SELECT_TAW_SEC01)
  SELECT * FROM mara INTO TABLE gt_mara WHERE (gv_where).
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* dynamic-where ok: a parenthesized condition is not dynamic
  SELECT * FROM mara INTO TABLE gt_mara WHERE ( mtart = 'FERT' OR mtart = 'HALB' ).
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* critical statements: one pseudo comment per statement
  EXEC SQL.
    COMMIT
  ENDEXEC.
  ROLLBACK WORK.

* at-in-restricted-loop: control levels in a LOOP with WHERE
  LOOP AT gt_marc INTO DATA(ls_marc) WHERE werks = '1000'.
    AT NEW matnr.
      WRITE / ls_marc-matnr.
    ENDAT.
  ENDLOOP.

* at-in-restricted-loop ok: the loop processes the whole table
  LOOP AT gt_marc INTO ls_marc.
    AT NEW matnr.
      WRITE / ls_marc-matnr.
    ENDAT.
  ENDLOOP.

* loop-modify-from-wa
  LOOP AT gt_mara INTO gs_mara.
    gs_mara-matkl = 'X'.
    MODIFY gt_mara FROM gs_mara.
  ENDLOOP.

* nested-linear-search: READ TABLE … WITH KEY on a standard table inside a loop
  LOOP AT gt_mara INTO gs_mara.
    READ TABLE gt_marc TRANSPORTING NO FIELDS WITH KEY matnr = gs_mara-matnr.
    IF sy-subrc = 0.
      CONTINUE.
    ENDIF.
  ENDLOOP.

* interface-call-in-loop
  LOOP AT gt_mara INTO gs_mara.
    go_reader->read( gs_mara-matnr ).
  ENDLOOP.
