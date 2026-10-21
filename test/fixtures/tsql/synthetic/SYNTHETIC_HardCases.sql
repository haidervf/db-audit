SET QUOTED_IDENTIFIER ON
GO
/* SYNTHETIC test proc (not from corpus) /* nested comment with DELETE FROM dbo.Fake */ still comment */
CREATE OR ALTER PROCEDURE [dbo].[Synthetic_HardCases]
    @tbl SYSNAME,
    @id INT = 0
WITH EXECUTE AS OWNER
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @sql NVARCHAR(MAX) = N'SELECT * FROM dbo.NotReal WHERE x = ''it''''s'' -- not a comment';
    DECLARE @audit TABLE (Id INT, Act NVARCHAR(10));
    DECLARE @rc INT, @cid INT

    CREATE TABLE #Work (Id INT PRIMARY KEY, Amt MONEY)
    SELECT o.Id, o.Amt INTO #Snap FROM dbo.Orders o WITH (NOLOCK) WHERE o.Status = 'NEW'
    INSERT #Work (Id, Amt) SELECT Id, Amt FROM #Snap
    INSERT INTO ##GlobalStage VALUES (1, 2)

    ;WITH Dupes AS (
        SELECT Id, ROW_NUMBER() OVER (PARTITION BY Ref ORDER BY Id) rn FROM dbo.Reviews
    )
    DELETE FROM Dupes WHERE rn > 1

    MERGE dbo.StockLevels AS t
    USING (SELECT w.Id, w.Amt FROM #Work w JOIN OtherDb.dbo.Members c ON c.Id = w.Id) AS s
        ON t.Id = s.Id
    WHEN MATCHED THEN UPDATE SET t.Amt = t.Amt + s.Amt
    WHEN NOT MATCHED THEN INSERT (Id, Amt) VALUES (s.Id, s.Amt)
    OUTPUT $action, inserted.Id INTO dbo.MergeAudit (Act, Id);

    UPDATE a SET a.Flag = 1
    OUTPUT deleted.Id, 'U' INTO @audit
    FROM dbo.Shelves a INNER JOIN [LINKSRV].[RemoteDb].[dbo].[Quotas] l ON l.Id = a.Id
    WHERE a.Id = dbo.fn_ResolveId(@id)

    DELETE a FROM dbo.Shelves a JOIN #Work w ON w.Id = a.Id
    DELETE TOP (100) FROM dbo.AuditLog WHERE CreatedAt < DATEADD(day, -90, GETDATE())
    TRUNCATE TABLE dbo.Staging

    DECLARE cur CURSOR LOCAL FAST_FORWARD FOR SELECT Id FROM dbo.Queue WITH (READPAST) WHERE Done = 0
    OPEN cur
    FETCH NEXT FROM cur INTO @cid
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC dbo.ProcessItem @ItemId = @cid, @Mode = 'FAST'
        EXEC @rc = ProcessItem2 @cid, 1
        IF @rc <> 0 BREAK
        FETCH NEXT FROM cur INTO @cid
    END
    CLOSE cur
    DEALLOCATE cur

    SELECT v.*, CASE WHEN v.X > 1 THEN 'END' ELSE 'BEGIN' END AS c
    FROM dbo.vw_Active v CROSS APPLY dbo.tvf_Split(v.Csv, ',') s, dbo.Lookup lk
    WHERE lk.Id = v.Id

    SET @sql = N'TRUNCATE TABLE dbo.' + QUOTENAME(@tbl)
    EXEC (@sql)
    EXEC sp_executesql @sql, N'@p INT', @p = 1
    EXEC LINKSRV.RemoteDb.dbo.RemoteProc @a = 1
    INSERT INTO @audit (Id, Act) EXEC dbo.GetAuditRows @id
    SELECT * FROM OPENQUERY(LINKSRV, 'SELECT * FROM remote.dbo.T')
    SELECT * FROM Archive..OldOrders
    DROP TABLE IF EXISTS #Work
    IF OBJECT_ID('tempdb..#Snap') IS NOT NULL DROP TABLE #Snap
    ELSE PRINT 'none'
END
GO
