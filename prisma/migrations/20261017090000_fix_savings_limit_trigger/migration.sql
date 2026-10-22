-- The original check_savings_limit() read NEW.savings_percentage / SUM(savings_percentage),
-- but the column is "savingsPercentage" (no @map), so every INSERT/UPDATE of an
-- active, in-progress goal failed with "record \"new\" has no field". Recreate the
-- function against the real column; the trigger definition is unchanged.
CREATE OR REPLACE FUNCTION check_savings_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_total INTEGER;
BEGIN
  SELECT COALESCE(SUM("savingsPercentage"), 0)
  INTO current_total
  FROM "SavingsGoal"
  WHERE "userId" = NEW."userId"
    AND "isActive" = true
    AND "status" = 'in_progress'
    AND "id" != NEW."id";

  IF (current_total + NEW."savingsPercentage") > 50 THEN
    RAISE EXCEPTION 'Total active savings cannot exceed 50%%';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
