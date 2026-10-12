-- Hockey 3-way (regulation-time) moneyline: stored as MONEYLINE with period
-- REGULATION and the outcome (home / away / draw) in pickedSide. Additive only -
-- no existing row is read or changed.
ALTER TYPE "Period" ADD VALUE 'REGULATION';
ALTER TYPE "PickedSide" ADD VALUE 'DRAW';
