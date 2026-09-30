*&---------------------------------------------------------------------*
*& Report Z_DEMO_PSEUDO
*&---------------------------------------------------------------------*
REPORT z_demo_pseudo.

TYPES: BEGIN OF ty_item,
         matnr TYPE matnr,
         werks TYPE werks_d,
       END OF ty_item.

DATA: lt_item  TYPE STANDARD TABLE OF ty_item,
      ls_item  TYPE ty_item,
      lv_dummy TYPE i,
      lv_tab   TYPE tabname,
      lv_used  TYPE i.

DATA lv_already TYPE i ##NEEDED.

FIELD-SYMBOLS <ls_item> TYPE ty_item.

CONSTANTS lc_text TYPE string VALUE 'Material not found'.

START-OF-SELECTION.

  lv_used = 1.

* 1) SELECT * + no WHERE + no ORDER BY + sy-subrc not checked
  SELECT * FROM mara INTO TABLE lt_item.

* 2) Statement already annotated: must not be listed again
  SELECT * FROM mara INTO TABLE lt_old. "#EC CI_ALL_FIELDS_NEEDED #EC CI_NOORDER #EC CI_NOWHERE #EC CI_SUBRC

* 3) SELECT inside a loop
  LOOP AT lt_item INTO ls_item.
    SELECT SINGLE matnr FROM mara
      INTO ls_item-matnr
      WHERE matnr = ls_item-matnr.
  ENDLOOP.

* 4) READ TABLE linear search + sy-subrc not checked
  READ TABLE lt_item INTO ls_item WITH KEY matnr = '000001'.

* 5) READ TABLE with sy-subrc check only gets CI_STDSEQ; DELETE ADJACENT without SORT → line 28 needs CI_NOORDER
  READ TABLE lt_item ASSIGNING <ls_item> WITH KEY werks = '1000'.
  IF sy-subrc = 0.
    DELETE ADJACENT DUPLICATES FROM lt_item COMPARING matnr.
  ENDIF.

* 6) SORT without BY
  SORT lt_item.

* 7) Dynamic SQL + CLIENT SPECIFIED
  SELECT * FROM (lv_tab) CLIENT SPECIFIED
    INTO TABLE lt_item
    WHERE mandt = sy-mandt
    ORDER BY PRIMARY KEY.

* 8) Empty CATCH
  TRY.
      lv_used = 1 / 0.
    CATCH cx_sy_zerodivide.
  ENDTRY.

* 9) Debug breakpoint
  BREAK-POINT.

* 10) Line that already has a regular end-of-line comment
  SELECT SINGLE matnr FROM mara INTO ls_item-matnr WHERE matnr = '1'. " read master data

  WRITE: / lc_text.
