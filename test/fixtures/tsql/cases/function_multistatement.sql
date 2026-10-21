CREATE FUNCTION [dbo].[tvf_Recent] (@Days INT)
RETURNS @Result TABLE (Id INT, Amt MONEY)
AS
BEGIN
    INSERT INTO @Result (Id, Amt)
    SELECT Id, Amt FROM dbo.Reviews WHERE CreatedAt > DATEADD(DAY, -@Days, GETDATE());
    RETURN;
END
