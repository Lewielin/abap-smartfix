*&---------------------------------------------------------------------*
*& Report Z_SMARTFIX_ATC_DEMO
*&---------------------------------------------------------------------*
* Invented program for the ATC matching tests (test/atc.js): the kinds of
* statements a real ATC run reports, with no customer code in it.
*&---------------------------------------------------------------------*
REPORT z_smartfix_atc_demo.

TABLES: mara, marm.

DATA: lt_items TYPE STANDARD TABLE OF zsf_demo_item WITH HEADER LINE,
      lt_mdkp  TYPE STANDARD TABLE OF mdkp WITH HEADER LINE,
      lt_plaf  TYPE STANDARD TABLE OF plaf,
      ls_plaf  TYPE plaf,
      lv_bklas TYPE bklas,
      gv_text  TYPE string.

START-OF-SELECTION.
  CLEAR lt_mdkp. REFRESH lt_mdkp.
  SELECT matnr menge FROM zsf_demo_item INTO CORRESPONDING FIELDS OF TABLE lt_items
    WHERE werks = '1000'.

  LOOP AT lt_items.
    SELECT SINGLE * FROM mara
      WHERE matnr = lt_items-matnr
        AND meins = 'PC'.
    IF sy-subrc = 0.
      SELECT SINGLE * FROM marm
        WHERE matnr = lt_items-matnr AND meinh = 'EA'.
      lt_items-menge = lt_items-menge * marm-umren.
    ENDIF.
    SELECT SINGLE bklas FROM mbew INTO lv_bklas
      WHERE matnr = lt_items-matnr.
    MODIFY lt_items.
  ENDLOOP.

  PERFORM update_target.
  PERFORM fix_orders.

*&---------------------------------------------------------------------*
*& Form update_target
*&---------------------------------------------------------------------*
FORM update_target.
  EXEC SQL.
    DELETE FROM zsf_demo_target
  ENDEXEC.
  LOOP AT lt_items.
    EXEC SQL.
      INSERT INTO zsf_demo_target ( matnr, menge )
        VALUES ( :lt_items-matnr, :lt_items-menge )
    ENDEXEC.
  ENDLOOP.
  EXEC SQL.
    COMMIT
  ENDEXEC.
  IF sy-subrc <> 0.
    gv_text = 'Update of the demo table failed'.
  ENDIF.
ENDFORM.

*&---------------------------------------------------------------------*
*& Form fix_orders
*&---------------------------------------------------------------------*
FORM fix_orders.
  SELECT * FROM plaf INTO TABLE lt_plaf WHERE auffx = ''.
  LOOP AT lt_plaf INTO ls_plaf.
    READ TABLE lt_items WITH KEY matnr = ls_plaf-matnr.
    IF sy-subrc = 0.
      lt_items-menge = ls_plaf-plnum.
    ENDIF.
  ENDLOOP.
ENDFORM.
