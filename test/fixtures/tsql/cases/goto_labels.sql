CREATE PROCEDURE dbo.WithGoto
AS
BEGIN
    DECLARE @tries INT = 0
Retry:
    SET @tries = @tries + 1
    IF @tries < 3 GOTO Retry
    IF @tries > 10 GOTO Done
    UPDATE dbo.Counters SET N = N + 1
Done:
    RETURN 0
END
