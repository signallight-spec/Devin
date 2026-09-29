ALTER TABLE app_settings
ADD COLUMN next_suggestion TEXT
  CHECK (
    next_suggestion IS NULL
    OR next_suggestion IN ('国語', '数学', '英語', '理科', '社会')
  );

ALTER TABLE app_settings
ADD COLUMN next_suggestion_date TEXT
  CHECK (
    next_suggestion_date IS NULL
    OR (
      length(next_suggestion_date) = 10
      AND substr(next_suggestion_date, 5, 1) = '-'
      AND substr(next_suggestion_date, 8, 1) = '-'
    )
  );
