*&---------------------------------------------------------------------*
*& Report Z_DEMO_AUTOFIX: code rewrite (Auto Fix) scenarios
*&---------------------------------------------------------------------*
REPORT z_demo_autofix.

CLASS lcl_worker DEFINITION.
  PUBLIC SECTION.
    METHODS run.
    DATA mt_mara TYPE STANDARD TABLE OF mara.
ENDCLASS.

DATA: lt_mara TYPE STANDARD TABLE OF mara,
      ls_mara TYPE mara,
      lv_cnt  TYPE i,
      lv_a    TYPE i,
      lv_b    TYPE p DECIMALS 2.
DATA gt_old TYPE STANDARD TABLE OF mara WITH HEADER LINE.
DATA go_obj TYPE REF TO lcl_worker.
DATA go_any TYPE REF TO object.

START-OF-SELECTION.

* 1) New syntax SELECT SINGLE (INTO at the end)
  SELECT SINGLE matnr FROM mara WHERE matnr = @ls_mara-matnr INTO @DATA(lv_matnr).
  IF sy-subrc <> 0.
    RETURN.
  ENDIF.

* 2) Classic syntax, no WHERE
  SELECT SINGLE * FROM mara INTO ls_mara.
  CHECK sy-subrc = 0.

* 3) SELECT SINGLE FOR UPDATE: cannot be rewritten, gets "#EC CI_NOORDER instead
  SELECT SINGLE FOR UPDATE matnr FROM mara INTO ls_mara-matnr WHERE matnr = '1'.
  CHECK sy-subrc = 0.

* 4) Code after the period on the same line: no rewrite and no end-of-line comment possible
  SELECT SINGLE matnr FROM mara INTO ls_mara-matnr WHERE matnr = '2'. lv_a = 1.
  CHECK sy-subrc = 0.

* 5) New syntax SELECT * (ORDER BY PRIMARY KEY is added when fixMode = rewrite)
  SELECT * FROM mara WHERE mtart = 'FERT' INTO TABLE @lt_mara.
  CHECK sy-subrc = 0.

* 6) Obsolete syntax
  MOVE 'X' TO ls_mara-matnr.
  ADD 1 TO lv_cnt.
  SUBTRACT lv_a FROM lv_cnt.
  MULTIPLY lv_b BY 2.
  DIVIDE lv_b BY lv_a.
  COMPUTE lv_a = lv_cnt * 2.
  REFRESH lt_mara.
  REFRESH gt_old.
  DESCRIBE TABLE lt_mara LINES lv_cnt.
  CALL METHOD go_obj->run.

* 7) Forms that must not be rewritten
  MOVE go_any ?TO go_obj.
  ADD 1 THEN lv_a UNTIL lv_b GIVING lv_cnt.

* 8) Chained MOVE: one assignment per line. A comment inside the statement: cannot be rewritten safely, left for manual fixing
  MOVE: lv_a TO lv_cnt, lv_cnt TO lv_a.
  MOVE lv_a " source
    TO lv_cnt.

* 9) BREAK user
  BREAK developer.

* 10) Obsolete pseudo comment → pragma
  DATA lv_keep1 TYPE i. "#EC NEEDED
  DATA lv_keep2 TYPE i. "#EC NEEDED kept for the interface
  WRITE / 'Hello'. "#EC NOTEXT
  SELECT SINGLE matnr FROM mara INTO ls_mara-matnr WHERE matnr = '3'. "#EC CI_SUBRC #EC WARNOK

CLASS lcl_worker IMPLEMENTATION.
  METHOD run.
    REFRESH mt_mara.
  ENDMETHOD.
ENDCLASS.
