-- Create a trigger function that prevents >50% active savings
CREATE OR REPLACE FUNCTION check_savings_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_total INTEGER;
BEGIN
  -- We sum percentages for active goals in progress
  -- excluding the current goal being updated if it's already active
  SELECT COALESCE(SUM(savings_percentage), 0)
  into current_total
  FROM "SavingsGoal"
  WHERE "userId" = NEW."userId"
    AND "isActive" = true
    AND "status" = 'in_progress'
    AND "id" != NEW."id";

  IF (current_total + NEW.savings_percentage) > 50 THEN
    RAISE EXCEPTION 'Total active savings cannot exceed 50%%';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists to avoid errors on migration retry
DROP TRIGGER IF EXISTS enforce_savings_limit ON "SavingsGoal";

-- Create trigger to run BEFORE INSERT OR UPDATE
CREATE TRIGGER enforce_savings_limit
  BEFORE INSERT OR UPDATE ON "SavingsGoal"
  FOR EACH ROW
  -- Only run check if the goal is being activated or already active
  WHEN (NEW."isActive" = true AND NEW."status" = 'in_progress')
  EXECUTE FUNCTION check_savings_limit();
