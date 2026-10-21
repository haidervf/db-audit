DECLARE @n BIGINT = NEXT VALUE FOR dbo.OrderSeq;
INSERT INTO dbo.Orders (Id, Ref) VALUES (NEXT VALUE FOR Sales.RefSeq, 'x');
SELECT NEXT VALUE FOR [dbo].[BatchSeq] AS b
