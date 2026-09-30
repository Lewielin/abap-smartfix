*&---------------------------------------------------------------------*
*& Report Z_DEMO_NO_FALSE_POSITIVE: valid code that must not get annotations
*&---------------------------------------------------------------------*
REPORT z_demo_no_false_positive.

TABLES ztab_log.

TYPES tty_sorted TYPE SORTED TABLE OF mara WITH UNIQUE KEY matnr.

DATA: gv_matnr  TYPE matnr,
      gt_mara   TYPE STANDARD TABLE OF mara,
      gt_sorted TYPE tty_sorted,
      gt_hash   TYPE HASHED TABLE OF mara WITH UNIQUE KEY matnr,
      gs_mara   TYPE mara,
      gv_cnt    TYPE i.

* 1) Selection screen: SELECT-OPTIONS / SELECTION-SCREEN are not Open SQL
SELECTION-SCREEN BEGIN OF BLOCK b1 WITH FRAME.
  SELECT-OPTIONS s_matnr FOR gv_matnr.
  SELECT-OPTIONS: s_werks FOR gs_mara-matnr,
                  s_mtart FOR gs_mara-mtart.
  PARAMETERS p_test AS CHECKBOX.
SELECTION-SCREEN END OF BLOCK b1.

AT SELECTION-SCREEN OUTPUT.
  LOOP AT SCREEN.
    MODIFY SCREEN.
  ENDLOOP.

START-OF-SELECTION.

* 2) INTO CORRESPONDING FIELDS OF TABLE is not a SELECT loop; later SELECTs are not inside a loop
  SELECT matnr mtart FROM mara
    INTO CORRESPONDING FIELDS OF TABLE gt_mara
    WHERE matnr IN s_matnr.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

  SELECT COUNT(*) FROM mara WHERE mtart = 'FERT'.
  gv_cnt = sy-dbcnt.

* 3) Internal table operations do not need a sy-subrc check
  INSERT gs_mara INTO TABLE gt_mara.
  DELETE gt_mara WHERE mtart = 'HALB'.
  LOOP AT gt_mara INTO gs_mara.
    gs_mara-mtart = 'FERT'.
    MODIFY gt_mara FROM gs_mara.
  ENDLOOP.
  SORT gt_mara BY matnr.
  DELETE ADJACENT DUPLICATES FROM gt_mara COMPARING matnr.

* 4) Key access on SORTED / HASHED tables is not a linear search
  READ TABLE gt_sorted INTO gs_mara WITH KEY matnr = gv_matnr.
  IF sy-subrc = 0.
    gv_cnt = 1.
  ENDIF.
  READ TABLE gt_hash INTO gs_mara WITH TABLE KEY matnr = gv_matnr.
  IF sy-subrc = 0.
    gv_cnt = 2.
  ENDIF.

* 5) SELECT SINGLE with = on key fields; WHERE ( … OR … ) is a regular condition, not dynamic SQL
  SELECT SINGLE mtart FROM mara INTO gs_mara-mtart WHERE matnr = gv_matnr.
  IF sy-subrc = 0.
    gv_cnt = 3.
  ENDIF.
  SELECT matnr FROM mara INTO TABLE gt_mara
    WHERE ( mtart = 'FERT' OR mtart = 'HALB' ).
  CHECK gt_mara IS NOT INITIAL.

* 6) SELECT … ENDSELECT: sy-subrc is checked after ENDSELECT (however long the loop body is)
  SELECT matnr FROM mara INTO gs_mara-matnr UP TO 10 ROWS WHERE mtart = 'FERT'.
    gv_cnt = gv_cnt + 1.
    gv_cnt = gv_cnt + 1.
    gv_cnt = gv_cnt + 1.
    gv_cnt = gv_cnt + 1.
  ENDSELECT.
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* 7) Activatable checkpoint, CALL TRANSACTION with authority check, "#EC * wildcard
  BREAK-POINT ID zdemo.
  CALL TRANSACTION 'MM03' WITH AUTHORITY-CHECK.
  SELECT * FROM t001 INTO TABLE @DATA(lt_t001). "#EC *

* 8) Still reported: database MODIFY without sy-subrc check
  MODIFY ztab_log FROM gs_mara.
  WRITE / gv_cnt.
